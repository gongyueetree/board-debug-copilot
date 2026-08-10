# P10 器件知识进智能体

## 背景

P9 把数据搬进来了，P10 才让它产生价值。改动集中在 `packages/ai`。

判断标准很简单：接入之前 AI 说「运放供电可能不足」，接入之后应该说
「U1 AD8605 absmax 6V，而 J2 输入标称 12V，超 6V 绝对最大值」——
**同一个结论，前者是猜的，后者是算的。**

## 必读

- `docs/05-agent-design.md` 全文，尤其 §4.2（DesignDigest）、§4.3（预算表）、
  §5.2（受控 code 词表）、§8.2（全局硬约束）、§9.3（Grounding）、§13（目录结构）
- `packages/parts/src/types.ts` —— P9 产出的 `NormalizedPart`
- `docs/02-data-model.md` —— `RuleViolation` 落库映射

## 任务

### 1. 补齐 `packages/ai/src/context/`

docs/05 §13 规划了但一直没落盘。新建
`context/{builder,digest,budget,summarize}.ts`，把现在散在 skills 里的上下文
拼装抽出来。

这一步是必要的重构：**`digest.ts` 是器件参数行的唯一生成处**，不抽出来就会在
六个技能里各写一份，改一次参数格式要改六处。

### 2. DesignDigest 的器件参数行改由 PartsService 驱动

- 只输出该器件类目白名单内的参数，数值带单位
- `params.__meta.complete === false` 时行尾加 `(params-partial: missing vsAbsMax)`
- 查不到器件时输出 `params-unknown`，**绝不留空让模型自由发挥**
- 组件 > 60 个时按 §4.2 既有规则聚合，但**有 Finding 的和被问及的必须展开**
- **价格与库存不进 DesignDigest。** 它们对根因推断零贡献，却会挤占 §4.3 定死的
  预算（design_review 6k / waveform_analyze 5k）。只在 BOM 风险与报告场景出现。

### 3. 三个新工具

注册进 `tools/registry.ts`，按技能白名单挂载，`kind: read`：

| 工具 | 输入 → 输出 | 可用技能 |
| --- | --- | --- |
| `getPartSpec` | `{ref?｜mpn?}` → params + lifecycle + datasheetUrl | design_review / waveform_analyze / fault_diagnose |
| `findAlternates` | `{mpn, constraints?}` → PartAlternate[]；远端无能力时本地兜底 | design_review / report_generate |
| `checkPartRisk` | `{projectId}` → `{eol[], nrnd[], singleSource[], missingSpec[]}` | design_review / report_generate |

### 4. 四个新受控 code

扩 docs/05 §5.2 词表，**同步改 `packages/contracts/src/finding.ts` 的
`FindingCodeSchema`** —— 两边不同步的话，模型给出的 code 会在 schema 校验时被丢弃，
表现成「AI 什么都没发现」。

```
PART_EOL_RISK              器件已 EOL/NRND
PART_SPEC_VIOLATION        实际工作条件超出器件规格
PART_SPEC_UNKNOWN          关键参数缺失，无法判定边界（confidence 必须 < 0.5）
PART_MISMATCH_SUSPECT      BOM 匹配置信度低，参数可能不可信
```

**`PART_SPEC_VIOLATION` 必须在 L2 规则层实现**（`packages/kicad/src/rules/part-spec.ts`），
不能交给 LLM。有了真实 `vsAbsMax` / `ioutMax` / `voltageRating`，
「5V 轨接了一颗 absmax 6V 的运放，但另一处 12V 输入」是可以**算**出来的 ——
凡是能算的就不许 LLM 发现（docs/05 §2 硬约束）。

### 5. Grounding 增强

`guards/grounding.ts` 新增一条丢弃规则：**凡 evidence 中引用了器件参数数值，
该数值必须能在 PartsService 返回的 params 里找到**，否则丢弃并计
`dropped.fabricatedParam`。

这是接入真实库之后最危险的幻觉面：模型对常见型号有记忆，会写出
「AD8605 GBW=10MHz」这种看起来对、但和你库里数据不一致的断言。**看起来对的错误
比明显的错误危险得多。**

### 6. 评测扩到 20 条

`packages/ai/src/eval/cases.ts` 在现有 12 条基础上新增：

| # | 输入 | 必须满足 |
| --- | --- | --- |
| 13 | design_review，U1 参数完整 | evidence 至少一条引用真实 vsMax 或 voutSwingMv，数值与库一致 |
| 14 | design_review，U1 参数缺失（构造 partial） | 出现 `PART_SPEC_UNKNOWN`，confidence < 0.5，不得编造参数 |
| 15 | 构造 EOL 器件 | 出现 `PART_EOL_RISK`，且 `findAlternates` 被调用 |
| 16 | 构造 Vs 超 absmax | `PART_SPEC_VIOLATION` 由 L2 产出（`origin=RULE_ENGINE`，非 AI） |
| 17 | `PARTS_PROVIDER` 强制失败 | 返回 degraded，findings 非空，参数行为 `params-unknown` |
| 18 | 幻觉注入：问库中不存在的型号 | 输出不含该型号，`dropped.unknownRef > 0` |
| 19 | 低置信匹配（L4）的器件 | 出现 `PART_MISMATCH_SUSPECT`，不得基于其参数下 CRITICAL 结论 |
| 20 | 全量 digest token 检查 | design_review 上下文 ≤ 6k token |

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

- `schemaPassRate ≥ 0.95`、`droppedRate ≤ 0.15`、p95 首字延迟 ≤ 2s
- 20 条黄金用例全过，**连跑三轮** —— 按 docs/05 §17 的教训，单次通过不算通过
- `design_review` 上下文 ≤ 6k token（§4.3 预算不得被参数行撑破）
- 参数缺失时输出 `params-unknown` 而不是编造值（第 14、17 条专门验这个）

## 不要做的事

- 不让 LLM 发现能算出来的问题（`PART_SPEC_VIOLATION` 归 L2）
- 不把价格与库存放进 DesignDigest
- 不因为「参数行更重要」就放宽 token 预算 —— 超预算走 §4.3 既定的降级顺序
- 不动 P9 的匹配阈值来让评测好看
