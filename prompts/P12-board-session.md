# P12 Board 与 DebugSession

## 背景

现在 `Capture` / `DebugStep` / `AiDiagnosis` / `BoardPhoto` / `DebugReport` 全部直接
挂 `projectId`，**所有批次的测量数据混在一起**。第二批板子出问题时，你没法把它和
第一批分开看，也就无法回答「这批 10 块里有 3 块 VOUT 偏低」这种真正有价值的问题。

P12 解决「一个项目多批板、一块板多次调试」，是后续做批次不良率统计的前提。

## 必读

- `docs/02-data-model.md`（**先改文档再改 schema**，纪律同 P11）
- `docs/03-ui-spec.md` 页面 5（问题描述横幅在读 `Project.currentIssue`）
- `docs/05-agent-design.md` §7.3（`AiDiagnosis.captureId @unique` 与 upsert 覆盖）
- `docs/05-agent-design.md` §17 #6（`primaryCode` 引入时埋的伏笔，P12 兑现）

## 任务

### 1. 两个新 model

`Board`（projectId + designVersionId + serialNo + batchNo + status + holder）
与 `DebugSession`（projectId + boardId? + designVersionId + title + issue + goal +
status + ownerId + rootCauseCode）。

`boardId` 允许为空：**还没登记实物就想先规划**是真实工作流。

字段定义见技术方案 §5，此处不重复。

### 2. 归属迁移

`Capture` / `DebugStep` / `AiDiagnosis` / `DebugReport` / `AiThread` 加
`sessionId String?`（先可空），`BoardPhoto` 加 `boardId String?`。

三步迁移，同 P11：

1. 加可空列
2. 回填：为每个已有项目建一条兜底 session
   （`title = "历史调试记录"`、`issue = Project.currentIssue ?? "未记录"`、
   `status = IN_PROGRESS`），把存量行全部指过去；有 `currentIssue` 的项目**额外**
   建一条对应的 `OPEN` session
3. 改非空

**`Project.currentIssue` 保留为只读镜像字段**（指向最近一条 OPEN session 的 issue），
不要删 —— 总览页与 docs/03 页面 5 的问题描述横幅都在读它，删了会连锁改六个页面。

`AiDiagnosis.captureId @unique` 这条约束**不变**，docs/05 §7.3 的
「重新分析必须 upsert 覆盖」继续有效。

### 3. 聚合能力（P12 真正的产出，不是表本身）

```
GET /api/v1/projects/:id/boards/stats
→ { byStatus: {...},
    byBatch: [{ batchNo, total, passed, failed, passRate }],
    topRootCauses: [{ code, count, boards: [serialNo] }] }
```

`topRootCauses` 依赖 `DebugSession.rootCauseCode`，而它只有在 `primaryCode` 是
**受控枚举**时才有意义 —— 这正是 docs/05 §17 #6 引入 `primaryCode` 时埋下的伏笔。

**session 关闭时由 `saveDiagnosis` 的最新一条诊断回写 `rootCauseCode`，
由确定性层写入，LLM 无权直接设置。**

### 4. API

```
GET|POST   /api/v1/projects/:id/boards
PATCH      /api/v1/boards/:id
GET        /api/v1/projects/:id/boards/stats
GET|POST   /api/v1/projects/:id/sessions
PATCH      /api/v1/sessions/:id
GET        /api/v1/sessions/:id/{captures,debug-steps,diagnoses/latest,reports/latest}
```

写操作沿用现有项目归属校验：公共 Demo（`userId` 为空）只读，他人写入 403。
响应全部经 Zod schema 校验后才返回。

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

- 迁移支持 `--dry-run`，回填后旧数据零丢失
- 存量项目回填出兜底 session，六个页面行为不变
- `boards/stats` 能按批次算出通过率，`topRootCauses` 有值
- `Project.currentIssue` 仍可读，总览页与页面 5 横幅正常
- `MOCK_MODE=true` 下内置 Demo 六个页面行为与升级前一致

## 不要做的事

- 不删 `Project.currentIssue`
- 不放开 `AiDiagnosis.captureId @unique`
- 不让 LLM 直接写 `rootCauseCode`
- 不在本阶段动 Bridge 的任何安全设计
