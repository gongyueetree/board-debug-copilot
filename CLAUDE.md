# Board Debug Copilot（准 LabSight 原型）— 项目记忆

## 项目一句话
工程师上传 KiCad 工程 + PCB 照片，通过本地 ADALM2000 Bridge 采集测量数据，AI 智能体综合设计上下文 + 元器件知识 + 测量数据 + 视觉信息，输出设计审查、调试计划、故障诊断和调试报告。

## 权威文档（必读，按需查阅）
- `docs/01-architecture.md` — 系统架构、部署拓扑、数据流
- `docs/02-data-model.md` — Prisma schema 全量定义（关系不可改）
- `docs/03-ui-spec.md` — 6 个页面的 UI 规格（对齐已确认的效果图）
- `docs/04-deploy.md` — Vercel/Railway 部署与环境变量
- `docs/05-agent-design.md` — 智能体设计（packages/ai 实施规格：路由/上下文/工具/输出 schema/守卫/流式/评测）
- `docs/07-operations.md` — 运维手册：mock/real 边界、异步任务、对象存储、KiCad 解析、Bridge 配对、生产注意事项

## 技术栈（已定，不要更换）
- Monorepo: pnpm + Turborepo + TypeScript
- 前端: Next.js App Router + Tailwind + shadcn/ui + Zustand + TanStack Query + Zod
- 波形: Canvas/uPlot（禁止用重型图表库画波形）
- PCB 照片标注: Konva
- 调试计划树/流程图: React Flow
- 后端: NestJS + Prisma + PostgreSQL(pgvector) + Redis + BullMQ
- Worker: Node.js（KiCad CLI 后接，先 mock）
- Bridge: Python 3.11 + FastAPI + websockets（仅监听 127.0.0.1:3777）
- AI: 模型适配器层（Gemini / Claude / DeepSeek 通过 `LLM_PROVIDER` 切换，缺 key 自动降级 mock；
  SDK import 只允许出现在 `packages/ai/src/providers/`，应用代码只见 `LlmProvider` 接口）

## 硬性原则（每次实施必须遵守）
1. 先可运行骨架，再补功能；每个 Phase 结束时 `pnpm dev` 必须能启动
2. 所有外部依赖（AI / KiCad CLI / ADALM2000 / 元器件库 / 对象存储）走 adapter，全部支持 mock 模式，`MOCK_MODE=true` 时全链路无外部依赖可演示
3. AI 输出必须结构化（Zod schema 校验），禁止只输出自由文本
4. 高频波形大数组不进 PostgreSQL —— 存对象存储，DB 只存测量摘要
5. 云端不得直接控制 USB；Bridge 只监听 localhost，浏览器直连 `ws://127.0.0.1:3777`
6. 危险仪器操作必须前端二次确认 **且** Bridge 端二次拦截；超硬件上限直接 422，confirm 也不放行；
   控制类接口需要配对 token，`/status` 与 `/emergency-stop` 除外
7. 上传文件必须校验类型和大小（zip ≤ 100MB，照片 ≤ 20MB，波形 ≤ 50MB，报告 ≤ 20MB）；
   用户文件名不得直接拼进 objectKey；大文件走 presign 直传，base64 只是 mock/开发兜底
8. KiCad CLI 失败写 parseLog，不能让整个项目崩溃
9. 报告先 Markdown，DOCX/PDF 导出后置
10. UI 严格对齐 `docs/03-ui-spec.md`，中文界面，深色顶栏 + 浅色内容区

## 代码风格
- JSX 中 `return` 后必须有空格或括号（历史 bug：`return<` 导致运行时错误）
- Canvas 组件必须用 ResizeObserver + devicePixelRatio 缩放
- shell 命令中不要包含中文行内注释
- 组件文件 ≤ 400 行，超过则拆分

## 目录结构（固定）
```
board-debug-copilot/
├── apps/web          # Next.js
├── apps/api          # NestJS
├── apps/worker       # BullMQ worker
├── apps/m2k-bridge   # Python FastAPI（独立，不进 turbo pipeline）
├── packages/db       # Prisma
├── packages/contracts# Zod DTO/schema（前后端共享）
├── packages/ai       # providers/agents/prompts/tools
├── packages/kicad    # parser/cli/graph
├── packages/ui       # 共享组件
├── packages/storage  # 对象存储 adapter（api 与 worker 共用）
└── packages/instrument-protocol  # Bridge 消息契约
```

## 已确立的做法（不要回退）
- **系统赋值字段不进模型面对的 schema**：`origin`、`id` 这类由服务端/数据库填的字段
  留在校验 schema 里会让每次 LLM 调用静默失败。模型面对的 schema 与响应 schema 分开定义。
- **下游据以分支的字段必须由确定性层约束**：`primaryCode`、`severity`、`requiresConfirm`
  都在守卫管线里强制，不能只靠 prompt 说明。
- **失败必须留痕**：静默 catch 会让「0 条结果」无从追查。
- **降级路径必须可执行**：不可执行的降级等于没有降级。
- **公共 Demo 只读**：匿名写会让任何访客污染所有人看到的数据。
- **解压不用系统 unzip**：逐条目校验路径穿越、符号链接、深度与总大小。
- **不要写「已验证真实硬件」**：ADALM2000 真实路径尚未验证。

## 内置 Demo（验收基准）
项目名 `Sensor Board Debug Demo`：AD8605 反相放大器（单电源 5V，Rin=10k, Rf=100k, 增益 -10）+ MCP4725 DAC + TPS7A02 LDO。
五个 mock 场景（Bridge `/debug/scenario` 切换，完整数值见 `docs/05` §11.1）：
`normal` Gain 9.98 / `gain_error`（默认，R2 桥接 → Gain 5.00, Phase -3.2°, THD+N 0.35%）/ `clipping`（THD+N 9.4% 贴轨）/ `noisy` / `no_response`（缺 Vref 偏置，对应 currentIssue）。
默认展示波形 #8：CH1 0.400Vpp @1kHz，CH2 2.002Vpp，Gain 5.00 V/V，Phase -3.2°。
该 Demo 必须在无硬件、无 KiCad CLI、无真实元器件库时完整跑通全部 6 个页面。

## 实施顺序
按 `prompts/P0` → `P8` 顺序执行，每个 Phase 有明确验收标准，验收不过不进下一阶段。

## Git / 部署
- GitHub 账号 `gongyueetree`，仓库 `gongyueetree/board-debug-copilot`（以 `gh auth status` 为准）
- 前端 Vercel，api/worker/PG/Redis 上 Railway；若后端 SSE/WS 在 Vercel 受限，整体迁 Railway（详见 docs/04）
