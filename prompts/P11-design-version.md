# P11 DesignVersion 实体化

## 背景

现在 `Project.designVersion` 只是个自增整数，解析一次 +1，但
`Component` / `Net` / `Pin` / `TestPoint` / `RuleViolation` 全挂在 `projectId` 上 ——
**重新解析会覆盖上一版的设计数据**。

而 docs/07 §4 又承诺「照片、捕获、调试步骤、报告一律保留」。两条合起来的结果是：
旧的捕获还在，但它对应的网表已经被新版本覆盖了。**证据链在这里是断的** ——
你打开一条三个月前的波形，看到的是今天的网表，而当时那颗电阻可能还是 10k。

P11 把版本实体化，让每一次解析的设计数据各自留存。

## 必读

- `docs/02-data-model.md` —— 现有关系（本阶段要改它，**先改文档再改 schema**）
- `docs/07-operations.md` §4（保留承诺）、§7（HNSW 索引）
- `packages/kicad/src/archive/parse-archive.ts` —— `replaceDesign()` 是被替换的对象

## 纪律变更（重要）

docs/02 开头写着「关系不可改」。那是 P0–P8 的冻结约定。**从 P11 起改为：
先改 docs/02，再改 schema，再写迁移，三者同一个 commit。禁止只改 schema 不改文档。**

## 任务

### 1. 新增 `DesignVersion`

```prisma
model DesignVersion {
  id String @id @default(uuid())
  projectId String
  version Int
  label String?                 // 用户可读，如 "v1.0" / "打样第二版"
  sourceFileId String?          // 指向 ProjectFile(KICAD_ZIP)
  parseStatus String
  parseLog String?
  ercJson Json?  drcJson Json?
  createdAt DateTime @default(now())
  project Project @relation(...)
  components Component[]  nets Net[]  testPoints TestPoint[]  violations RuleViolation[]
  @@unique([projectId, version])
}
```

`Component` / `Net` / `TestPoint` / `RuleViolation` 的归属改为 `designVersionId`。
**保留 `projectId` 冗余列做查询优化，但外键以 `designVersionId` 为准** ——
「这个项目所有版本的组件」是高频查询，绕一层 join 不划算。

### 2. 三步迁移，可回滚

**不能一把梭。** 顺序：

1. 加**可空**列 `designVersionId`
2. 回填：为每个 project 建一条 `version = 当前 designVersion` 的记录，
   把存量行指过去
3. 改为**非空**并加约束

`scripts/migrate-design-version.ts` 必须支持 `--dry-run` 与 `--project <id>` 逐项目执行。
回填后**旧数据零丢失**是硬指标 —— 迁移前后 `Component` / `Net` / `RuleViolation`
的总行数必须一致，脚本自己打印这个对比。

### 3. `parse-archive.ts` 改造

现在的 `replaceDesign()` 是 `deleteMany` + 重建。改为：**新建一条 DesignVersion，
把新数据挂上去，旧版本原样留着**。`Project.designVersion` 保留为「最新版本号」
的镜像字段，继续 +1。

### 4. 前端版本切换器

项目顶栏加版本切换。切换时设计审查页与 BOM 页跟着切。

**调试工作台的历史捕获显示「采集于 v1，当前查看 v2」的横幅** ——
不隐藏跨版本证据，只标注。隐藏等于把断掉的证据链藏起来，比断掉本身更糟。

### 5. API

```
GET /api/v1/projects/:id/design-versions
GET /api/v1/design-versions/:id/design
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

- 迁移支持 `--dry-run`，回填后旧数据零丢失（行数对比由脚本打印）
- 同一项目连续解析两次，两版设计数据都在，旧捕获仍指向它当时那一版
- 前端能切版本；跨版本捕获有横幅标注而不是被隐藏
- `MOCK_MODE=true` 下内置 Demo 六个页面行为与升级前一致
- docs/02 与 schema 在同一个 commit 里同步更新

## 不要做的事

- 不删 `Project.designVersion`（六个页面在读它）
- 不在一次迁移里从可空直接跳到非空
- 不隐藏跨版本的历史证据
- 不动 `Capture` / `DebugStep` 的归属（那是 P12 的事）
