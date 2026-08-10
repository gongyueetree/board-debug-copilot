# P9 110 万器件库接入层

## 背景

`DesignDigest` 里那一行

```
U1 AD8605 SOIC-8 opamp RRIO Vs=2.7~5.5V(absmax 6V) Ib=1pA GBW=10MHz Vout=rail-to-rail(±20mV)
```

是整个智能体的价值来源（docs/05 §4.2 原话：「这一段对输出质量的贡献大于其它所有
段落之和」）。现在它来自内置常识参数 —— 只有 Demo 里那几颗器件有。接上 110 万条
的真实器件库之后，任何工程传上来的板子都能生成这一行。

P9 只做数据接入，不碰智能体。**P9 做完之后 AI 的输出不会变好**，变好是 P10 的事。
把两件事分开是为了让「匹配率」这个指标能被单独验收。

## 必读

- `CLAUDE.md` —— 硬性原则 #2（adapter + mock）、目录结构表（本阶段要改它）
- `docs/02-data-model.md` —— 现有 Component / PartMatch / PartKnowledge
- `docs/05-agent-design.md` §4.2（器件参数行长什么样）、§4.3（token 预算）
- `docs/07-operations.md` §1（mock/real 边界表，本阶段要加一行）、§7（HNSW 索引）

## 任务

### 1. 新增 `packages/parts`

放共享包而不是塞进任一 app：api 与 worker 都要用，分成两份迟早漂移 ——
理由与当初新增 `packages/storage` 一致。**同时要改 `CLAUDE.md` 的目录结构表**，
那张表现在不含 `packages/parts`。

```
packages/parts/src/
├── index.ts          对外只导出 PartsService 与类型，不导出 provider
├── types.ts          NormalizedPart / PartQuery / MatchResult / ParamSpec
├── providers/        base / mock / remote / factory
├── mapping/          field-map / category-map / unit   ← 参考文件落地处
├── normalize/        params / mpn
├── match/            四层匹配管线 + scoring
├── cache/            memory(LRU) / mirror(Postgres + TTL)
└── knowledge/        embed / retrieve（迁移现有 parts.service 的向量检索）
```

**`fetch` / `axios` 只允许出现在 `providers/remote.ts`。** 这与
`packages/ai` 里「SDK import 只允许出现在 `providers/`」是同一条纪律：
远端字段长什么样、分页怎么翻、鉴权怎么做，全部只影响一个文件。

### 2. Provider 接口

```ts
export interface PartsProvider {
  readonly name: 'mock' | 'remote'
  readonly capabilities: {
    exactLookup: boolean; keywordSearch: boolean; batchLookup: boolean
    alternates: boolean;  lifecycle: boolean;    parametric: boolean
  }
  getByMpn(mpn: string): Promise<RawPart | null>
  batchGetByMpn(mpns: string[]): Promise<Map<string, RawPart>>
  searchByKeyword(q: string, opts?: { category?: string; limit?: number }): Promise<RawPart[]>
  searchParametric?(q: ParametricQuery): Promise<RawPart[]>
  getAlternates?(mpn: string): Promise<RawAlternate[]>
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>
}
```

`capabilities` 不是装饰。上游据它决定要不要降级到本地策略 —— 远端没有
`alternates`，`findAlternates` 就走「同类目 + 参数区间 + 向量相似」的本地兜底，
**而不是返回空数组让 LLM 自己编**。

### 3. 参考文件（未提供时不要猜）

`providers/remote.ts` 与 `mapping/field-map.ts` 需要这九项才能一次写对：

1. Base URL 与环境区分
2. 鉴权方式（Header / 签名 / 有效期 / 是否需要刷新）
3. 端点清单（MPN 精确查、关键词模糊查、批量查、类目树、替代料，各自 method 与参数）
4. 分页与总量约定
5. 完整字段字典（含义、类型、单位、是否可空）
6. 至少 3 条真实响应样例（一条阻容、一条 IC、一条查不到的空结果）
7. 限流规则（QPS、并发、日配额）
8. 错误码表
9. 类目字典（用于 `category-map.ts`）

**缺哪项就写哪项的 TODO 并让 `/health` 报出来，不要猜。** 猜出来的字段映射会
安静地产出错误参数，而错误的 `vsAbsMax` 会让 AI 得出一个看起来极其笃定的错误根因。

### 4. 参数抽取白名单

按类目定义必抽参数。抽不到不许静默：

```jsonc
paramsJson.__meta = { complete: false, missing: ['vsAbsMax'], parser: 'opamp@v1' }
```

并在 `DesignDigest` 里把该器件降级为 `params-unknown`，让 LLM 在 evidence 里写
「缺 XX 参数」而不是编一个（docs/05 §8.2 第 3 条）。

| 类目 | 必抽参数 |
| --- | --- |
| OPAMP | vsMin vsMax vsAbsMax rrio ibTyp gbw slewRate voutSwingMv isupply |
| LDO / DCDC | vinMin vinMax voutNom ioutMax dropoutMv coutMin coutEsr pgThreshold |
| ADC / DAC | bits interface i2cAddr vrefMin vrefMax sampleRate vddMin vddMax |
| MCU / FPGA | coreV ioV ioTolerant resetActive bootPins swdPins |
| RESISTOR | resistance tolerance powerW tempco |
| CAPACITOR | capacitance voltageRating dielectric tolerance |
| INDUCTOR | inductance isat dcr |
| DIODE/LED/MOSFET | vf ifMax vrrm / vgsTh rdsOn vdsMax idMax |
| CONNECTOR | pins pitch currentRating |

### 5. 四层匹配管线（Component → Part）

命中即停，每层独立置信区间：

| 层 | 方法 | confidence |
| --- | --- | --- |
| L1 | MPN 精确（归一化后） | 0.95–1.0 |
| L2 | 制造商 + 型号前缀（`AD8605ARTZ-REEL7` → `AD8605`） | 0.75–0.94 |
| L3 | 参数化（类目 + 值 + 封装），阻容感主力路径 | 0.55–0.80 |
| L4 | 向量语义（description 相似），兜底 | 0.30–0.60 |

**`confidence < 0.6` 一律 `accepted = false` + `matchStatus = NEEDS_REVIEW`**，
前端出「待确认」角标由人确认。自动采纳低置信匹配是这类系统最典型的翻车方式。

### 6. 三级缓存与限流

进程内 LRU（2000 / 60s）→ Postgres `Part` 镜像（TTL 7 天，过期后异步刷新、
**先返回旧值不阻塞**）→ 远端 API。

只镜像「项目真正用到的」+ 预热脚本拉的高频器件。**110 万条不要全量导入本地库。**

批量查询必须做：分片（50/批）、并发上限（4）、指数退避（429/5xx，最多 3 次）、
整体超时（15s）、幂等键（归一化 mpn）。BOM 一次上百行，不做这些第一次真实解析
就会被限流打回。

### 7. Schema 增量（只加列加表，不动任何既有关系）

新增 `PartCategory` / `PartLifecycle` / `MatchMethod` / `MatchStatus` 四个 enum，
`Part` / `PartAlternate` 两个 model；`Component` 加 `partId` + `matchStatus`，
`PartMatch` 加 `method` / `accepted` / `reviewedBy` / `reviewedAt`（`source` 保留做
历史兼容），`PartKnowledge` 加 `partId` / `embeddingModel` / `version`。

字段定义见技术方案 §2.7，此处不重复。

### 8. 回填脚本

`scripts/backfill-parts.ts`：遍历存量 Component 跑匹配管线，写
`Part` / `PartMatch` / `Component.partId`。必须支持 `--dry-run` 与 `--project <id>`，
**输出 L1/L2/L3/L4/未匹配的分层占比 —— 这个统计就是 P9 的验收依据。**

`pnpm parts:warm --category opamp,ldo,dac --top 500` 预热向量底料。没有它
`PartKnowledge` 是空的，`searchPartsDatabase` 工具永远返回零条，跟没接一样。

### 9. 环境变量与降级

```bash
PARTS_PROVIDER=mock|remote        # 默认 mock
PARTS_API_BASE_URL=
PARTS_API_KEY=                    # 仅服务端，禁止出现在 apps/web
PARTS_CACHE_TTL_DAYS=7
PARTS_BATCH_SIZE=50
PARTS_MAX_CONCURRENCY=4
PARTS_TIMEOUT_MS=15000
PARTS_EMBED_ON_MIRROR=true
```

降级链：远端不可用 → 镜像（即使过期）→ mock 内置常识参数 → 标 degraded。

`GET /health` 增加 `parts` 段，与现有 `llm.degraded` / `storage.degraded` 同构：

```json
"parts": { "provider": "remote", "degraded": false, "mirrorHit": 0.83,
           "lastError": null, "latencyP95Ms": 240 }
```

## 硬约束（这五条是已经付出过代价换来的，逐条不得违反）

1. **外部依赖走 adapter 且必须支持 mock。** `MOCK_MODE=true` 时全链路无外部依赖
   可完整演示：无 ADALM2000、无 KiCad CLI、无真实 LLM、无 S3/R2、**无器件库 API**。
   MOCK_MODE 下禁止发起任何真实网络请求。
2. **模型面对的 schema 与响应 schema 分开定义。** 系统赋值字段（`id`、`origin`、
   `partId`、`matchStatus`、`fetchedAt`）绝不进模型 schema —— 让模型填它填不了的
   字段，只会得到编造的值。
3. **下游据以分支的字段由确定性层强制。** `primaryCode`、`severity`、
   `requiresConfirm`、`matchStatus`、`accepted` 一律由代码写入，不靠 prompt 说明。
4. **失败必须留痕，禁止静默 catch。** 降级要在 `/health` 与 parseLog 里可见；
   参数抽不到就写 `__meta.missing`，不要留空让下游自由发挥。
5. **`PartKnowledge_embedding_idx` 的 `DROP INDEX` 提示一律忽略。** 那个 HNSW
   索引是原始 SQL 建的，`prisma migrate diff` 会持续提示删它 —— 不要写进迁移文件
   （docs/07 §7 已明确）。

## 验收标准

- `pnpm dev` 可启动
- **`MOCK_MODE=true` 下 6 个页面与内置 Demo 行为与升级前完全一致**（回归底线）
- `PARTS_PROVIDER=remote` 时对 Demo 的 22 个组件跑回填：**L1+L2 匹配率 ≥ 70%**、
  人工抽检 20 条**误匹配 = 0**
- 断网时 `/health` 报 `parts.degraded=true` 且 BOM 页仍能渲染
- `pnpm test` 新增 `packages/parts` 单测：MPN 归一化、单位归一、四层匹配、
  批量分片与退避
- 按类目统计参数完整率并记录 —— **这个数字决定 P10 的实际收益**

## 不要做的事

- 不把 110 万条全量导入本地库
- 不在没有参考文件时猜远端字段映射
- 不自动采纳 `confidence < 0.6` 的匹配
- 不把价格与库存放进 `params`（单独 `commercialJson`，理由见 P10）
- 不动 `Project` / `Component` 的既有关系（那是 P11 的事）
- 不改智能体（那是 P10 的事）
