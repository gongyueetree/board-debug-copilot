# 11 · 器件库接入

`packages/parts` 只做一件事：把一个我们不控制的外部器件库，收敛成内部稳定的
`NormalizedPart`。远端字段长什么样、分页怎么翻、鉴权怎么做，全部只影响
`providers/remote.ts` 与 `mapping/` 两处 —— 与 `packages/ai` 里「SDK import 只允许
出现在 `providers/`」是同一条纪律。

---

## 1. 当前状态

| 项 | 状态 |
| --- | --- |
| 内部模型与归一化（MPN / 单位 / 封装 / 类目） | ✅ 单元测试覆盖 |
| 四层匹配管线 + 置信阈值 | ✅ 单元测试覆盖 |
| 三级缓存（LRU / 镜像 / 远端） | ✅ 单元测试覆盖 |
| mock provider（内置常识参数） | ✅ 全链路可跑 |
| `/health` 的 `parts` 段 | ✅ 与 `llm` / `storage` 同构 |
| 回填脚本与分层统计 | ✅ `pnpm parts:backfill --dry-run` |
| **110 万器件库真实接入** | ⬜ **NOT RUN** — 接入信息未提供，见 §2 |

mock provider 下对内置 Demo 跑回填的结果（174 个组件，含三个项目）：

```
  L1    MPN 精确         0    0.0%
  L2    型号前缀        24   13.8%
  L3    参数化           0    0.0%
  L4    向量语义         0    0.0%
  —     未匹配         150   86.2%
```

**13.8% 是内置库只有 5 颗器件的必然结果，不是管线有问题。** L1 为 0 也正常：
seed 用的是真实订货号（`AD8605ARZ` / `TPS7A0233PDBVR`），基础型号要靠 L2 剥出来。
≥ 70% 的验收线是给 `PARTS_PROVIDER=remote` 的。

---

## 2. 接入需要的九项信息

`providers/remote.ts` 里的 `MISSING_SPEC` 就是这张表。**一项都还没拿到。**

| # | 项 | 影响 |
| --- | --- | --- |
| 1 | Base URL 与环境区分 | `RemoteConfig.baseUrl` |
| 2 | 鉴权方式（Header / 签名 / 有效期 / 刷新） | 请求头构造与 token 续期 |
| 3 | 端点清单（MPN 精确 / 关键词 / 批量 / 类目树 / 替代料） | 五个方法各自的 URL 与参数 |
| 4 | 分页与总量约定 | `searchByKeyword` 的翻页 |
| 5 | 完整字段字典（含义、类型、单位、可空性） | `mapping/field-map.ts` 的 `FIELD_PATHS` |
| 6 | ≥ 3 条真实响应样例（阻容 / IC / 空结果） | 映射的验证用例 |
| 7 | 限流规则（QPS、并发、日配额） | `PARTS_BATCH_SIZE` / `PARTS_MAX_CONCURRENCY` 的取值 |
| 8 | 错误码表 | `PartsError.code` 的映射与 retryable 判定 |
| 9 | 类目字典 | `mapping/category-map.ts` 的 `EXPLICIT_CATEGORY_MAP` |

### 为什么不先猜着写

猜出来的字段映射会**安静地**产出错误参数。而错误的 `vsAbsMax` 会让 AI 得出一个
看起来极其笃定的错误根因 —— 比「查不到这颗器件」危险得多，因为后者会触发
`params-unknown`，前者不会触发任何东西。

所以现在的行为是：`RemotePartsProvider` 的每个方法都抛 `NOT_CONFIGURED`，
`PartsService` 降级到镜像 / mock，`/health` 的 `parts.missingSpec` 把缺什么列出来。

### 拿到之后要改的地方，按顺序

1. 填 `providers/remote.ts` 的 `ENDPOINTS` / `AUTH` / `PAGING` / `RATE_LIMIT` 常量
2. 把 `mapping/field-map.ts` 的 `FIELD_PATHS` 换成真实字段名
3. 把 `mapping/category-map.ts` 的 `EXPLICIT_CATEGORY_MAP` 填上类目字典
4. 把 `capabilities` 按远端实际能力置位（**没有的能力必须写 false**，
   上游据它走本地兜底而不是拿到空数组）
5. 删掉 `assertConfigured()` 的调用，清空 `MISSING_SPEC`
6. `PARTS_PROVIDER=remote pnpm parts:backfill --dry-run` 看分层匹配率

其余代码一行都不用动 —— 这正是把映射收敛到一个文件的意义。

---

## 3. 环境变量

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

`MOCK_MODE=true` 时即使 `PARTS_PROVIDER=remote` 也强制走 mock，且不发起任何
真实请求（CLAUDE.md 硬性原则 #2，也是 CI 不消耗真实配额的前提）。

---

## 4. 降级链

```
远端 API ──失败──> Postgres 镜像（即使过期）──没有──> mock 内置常识参数
                                                        └─> 标 degraded
```

`GET /health`：

```json
"parts": {
  "provider": "remote",
  "degraded": true,
  "mirrorHit": 0.83,
  "lastError": "NOT_CONFIGURED: 器件库 API 尚未接入：缺少 9 项接入信息",
  "latencyP95Ms": null,
  "missingSpec": ["baseUrl: ...", "auth: ...", "..."]
}
```

与 `llm.degraded` / `storage.degraded` 形状一致 —— 运维不该为了看两种降级去读
两种不同的结构。

**器件库降级不影响 `/health` 的 `status`**（会退到内置常识参数，服务照常可用），
但必须报出来：参数不准会安静地降低 AI 输出质量，没有别的信号。

---

## 5. 三级缓存

| 层 | 容量 / TTL | 挡什么 |
| --- | --- | --- |
| 进程内 LRU | 2000 / 60s | 同一次解析里的重复查询（一块板 24 颗 10k 电阻查 24 次同一个 MPN） |
| Postgres `Part` 镜像 | TTL 7 天 | 跨请求、跨进程复用；**过期后先返回旧值再异步刷新** |
| 远端 API | — | 前两层都没有时 |

过期先返回旧值是有意的：器件参数一周不变是常态，为了拿最新的 1% 差异让 BOM 页
多等两秒不划算。刷新失败不影响本次返回，只是下次还会再试。

**只镜像「项目真正用到的」+ 预热脚本拉的高频器件。110 万条不全量导入** ——
没必要也难维护，全量之后 TTL 刷新会变成一个独立的运维负担。

---

## 6. 四层匹配

| 层 | 方法 | confidence | 典型对象 |
| --- | --- | --- | --- |
| L1 | MPN 精确（归一化后） | 0.95–1.0 | BOM 里写了准确型号 |
| L2 | 型号前缀 | 0.75–0.94 | `AD8605ARZ` → `AD8605` |
| L3 | 参数化（类目 + 值 + 封装） | 0.55–0.80 | 阻容感，无 MPN |
| L4 | 向量语义 | 0.30–0.60 | 兜底，**永不自动采纳** |

`confidence < 0.6` 一律 `accepted = false` + `matchStatus = NEEDS_REVIEW`。

L2 的前缀候选由长到短，先试最具体的。**逐位截断到 6 位**而不是只剥尾字母 ——
真实订货号里基础型号后面常跟数字（`TPS7A0233PDBVR` 的基础型号是 `TPS7A02`，
中间的 `33` 是输出电压代码），只剥字母会停在 `TPS7A0233`，永远到不了。

---

## 7. 参数抽取

按类目白名单抽（见 `normalize/params.ts` 的 `PARAM_WHITELIST`）。抽不到写进
`__meta.missing`：

```jsonc
"paramsJson": {
  "vsMin": { "value": 2.7, "unit": "V", "raw": "2.7 V" },
  "vsMax": { "value": 5.5, "unit": "V", "raw": "5.5 V" },
  "__meta": { "complete": false, "missing": ["vsAbsMax", "gbw"], "parser": "mock@v1" }
}
```

`complete: false` 时 DesignDigest 把该器件降级为 `params-unknown`（P10 实现），
让 LLM 在 evidence 里写「缺 XX 参数」而不是编一个。

**认不出的类目落 `OTHER`，而 `OTHER` 的白名单是空的** —— 这是有意的失败方式：
认不出就不抽参数，而不是抽错参数。

参数完整率按类目统计，`pnpm parts:backfill` 会打印。**这个数字决定 P10 的实际收益。**

---

## 8. 脚本

```bash
# 回填：遍历存量 Component 跑匹配管线，输出分层匹配率
pnpm parts:backfill --dry-run
pnpm parts:backfill --project <id>
PARTS_PROVIDER=remote pnpm parts:backfill

# 预热：给向量检索准备底料
pnpm parts:warm --category opamp,ldo,dac --top 500
```

没有预热的话 `PartKnowledge` 是空的，`searchPartsDatabase` 工具永远返回零条 ——
接了 110 万条也跟没接一样。

---

## 9. 迁移注意

`PartKnowledge.embedding` 上的 HNSW 索引由原始 SQL 创建，Prisma 表达不了向量索引，
所以 **`prisma migrate diff` 每次都会生成 `DROP INDEX PartKnowledge_embedding_idx`**。

P9 的迁移文件里这句已经手工删掉了。删掉它的后果是**向量检索退化成全表扫描，
而且不报错，只是变慢** —— 这种失败没有任何信号。

`packages/db/test/migrations.test.ts` 会扫所有迁移文件挡住这件事，
往迁移里加一句 `DROP INDEX ... PartKnowledge_embedding_idx` 立刻测试变红。
