# P13 前端页面与运维收口

## 背景

P9–P12 的能力都在后端。P13 把它们接到界面上，并把运维口子收干净 ——
否则「接了 110 万器件库」这件事，用户在界面上一点都看不见。

## 必读

- `docs/03-ui-spec.md` —— 六页版式（本阶段新增页面要对齐它）
- `docs/07-operations.md` §1（mock/real 边界表，本阶段要更新状态）
- `CLAUDE.md` —— 权威文档清单（本阶段要登记 `docs/11-parts-database.md`）

## 任务

### 1. 新增页面

| 路由 | 内容 | 复用 |
| --- | --- | --- |
| `/parts` | 器件库检索：关键词 + 类目 + 参数区间；`parts.degraded` 显示为顶部灰条 | 现有 `/api/v1/parts/search` |
| `/parts/[mpn]` | 参数表（**缺失项显式标灰**）、lifecycle 徽标、替代料、datasheet、"被哪些项目用过" | `getPartSpec` / `findAlternates` |
| `/projects/[id]/boards` | 板卡列表 + 批次统计卡 + 状态流转 | `StatCard` / `RiskPill` |
| `/projects/[id]/sessions` | 会话列表 | 六页版式不变 |

现有 `app/projects/[id]/{bench,plan,report}` 迁到 `sessions/[sid]/` 下。
**`projects/[id]/bench` 保留为重定向到「最近一条 OPEN session」**，避免存量链接全断。

### 2. BOM 页改造（P9 的前端出口）

每行加匹配状态列：`MATCHED`（绿）/ `NEEDS_REVIEW`（橙，可点开对比候选并手工确认，
确认动作写 `PartMatch.accepted` + `reviewedBy`）/ `UNMATCHED`（灰）。

顶部加汇总：`已匹配 28 / 待确认 2 / 未匹配 1`，以及 `checkPartRisk` 的 EOL / NRND 徽标。

**参数缺失项要显式标灰，不能不显示。** 不显示等于让用户以为这颗器件参数齐全。

### 3. 运维收口

docs/07 §1 的 mock/real 边界表新增一行：

```
元器件库 | 内置常识参数 | 110万器件库 API | PARTS_PROVIDER=remote | 状态按实测填写
```

**不要写「已验证」。** 只有真的对着真实接口跑通回填并抽检过，才把状态改成 ✅ ——
沿用仓库既有纪律（CLAUDE.md「已确立的做法」明确禁止在未实测时写已验证）。

`pnpm smoke` 增加三项：

1. `/health` 的 `parts` 段存在且字段完整
2. `/api/v1/parts/search?q=` 返回非空（remote）或返回内置结果（mock）
3. BOM 页 SSR 输出含匹配状态列

CI 三层结构不变，**集成层固定 `PARTS_PROVIDER=mock`** —— CI 不该消耗真实配额，
也不该因为器件库接口抖动变成不稳定测试。真实接口联调走手动触发的 workflow。

### 4. 新增文档

`docs/11-parts-database.md`：接入契约、字段映射表、类目映射表、限流与配额、
降级行为、预热脚本用法。**并在 `CLAUDE.md` 的权威文档清单里登记。**

> 编号用 11 不用 10：`docs/10` 已经是 ADALM2000 硬件验证 checklist。

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

- 四个新页面可用，`/parts` 在 degraded 时有顶部灰条
- BOM 页三种匹配状态可见，`NEEDS_REVIEW` 可人工确认并落库
- `pnpm smoke` 三项新检查通过
- CI 集成层跑在 `PARTS_PROVIDER=mock` 下
- docs/07 §1 有元器件库这一行，状态**按实测填**
- `MOCK_MODE=true` 下内置 Demo 六个页面行为与升级前一致

## 不要做的事

- 不做大 UI 改版，六页版式不变
- 不在未实测时把边界表状态写成 ✅
- 不让 `PARTS_API_KEY` 出现在 `apps/web` 的任何代码或环境变量里
- 不让存量链接失效（`projects/[id]/bench` 必须重定向）
