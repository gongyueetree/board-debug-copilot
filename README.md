# Board Debug Copilot（准 LabSight 原型）

工程师上传 KiCad 工程 + PCB 照片，通过本地 ADALM2000 Bridge 采集测量数据，
AI 智能体综合**设计上下文 + 元器件知识 + 测量数据 + 视觉信息**，
输出设计审查、调试计划、故障诊断和调试报告。

## 真实链路验证状态

「测试脚本通过」不等于「真实链路已验证」。下表只有三种取值：
**VERIFIED**（对着真实依赖跑过）/ **NOT RUN**（没跑过）/ **EXPERIMENTAL**（能跑但未验证）。

| 链路 | 状态 | 依据 |
| --- | --- | --- |
| Mock Demo（6 个页面 + 智能体） | ✅ VERIFIED | CI `集成` job：`pnpm smoke` 33/33、`pnpm test:agent` 12/12 |
| 单元测试 | ✅ VERIFIED | CI `类型/构建/单元测试` job：`pnpm test` 122 项 |
| MinIO 对象存储 | ✅ VERIFIED | CI `存储（MinIO 端到端）` job：`pnpm test:storage-real` 7/7 |
| **KiCad CLI 解析（10.0.1 / macOS）** | ✅ **VERIFIED** | `pnpm test:kicad-real` 4/4 真实工程，2026-08-09，详见 [docs/08](docs/08-real-kicad-validation.md) §4 |
| KiCad CLI 其它版本（6/7/8/9）与 Linux/Windows | ⬜ NOT RUN | 装好对应版本后跑 `pnpm test:kicad-real`，结果填 docs/08 §4 |
| Cloudflare R2 | ⬜ NOT RUN | `cp .env.r2.example .env.r2` 填好后跑 `pnpm test:storage-real`，见 [docs/09](docs/09-storage-validation.md) §3 |
| AWS S3 | ⬜ NOT RUN | 同上，配置见 [docs/09](docs/09-storage-validation.md) §4 |
| **浏览器直传**到真实对象存储 | ⬜ NOT RUN | `pnpm test:storage-real` 在 Node 里跑，不经过 CORS。见 [docs/09](docs/09-storage-validation.md) §6 |
| ADALM2000 Mock Bridge | ✅ VERIFIED | CI `Bridge (pytest)` job：24 项 + 冒烟里的危险操作拦截 |
| **ADALM2000 真实硬件** | ⚠️ **EXPERIMENTAL / NOT RUN** | 没有硬件也没装 libm2k。checklist 见 [docs/10](docs/10-adalm2000-hardware-validation.md)，`hardwareVerified` 保持 `false` |
| 真实 LLM（Gemini） | ✅ VERIFIED | `LLM_PROVIDER=gemini pnpm test:agent` 11/11（早期验证） |

逐步接上真实依赖的三条命令，缺依赖时都会 SKIPPED 而不是失败：

```bash
pnpm test:kicad-real     # 需要 kicad-cli        → docs/08
pnpm test:storage-real   # 需要 MinIO/R2/S3      → docs/09
cd apps/m2k-bridge && python scripts/hardware_smoke.py   # 需要 ADALM2000 → docs/10
```

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- web → http://localhost:3000
- api → http://localhost:3001/health

`MOCK_MODE=true`（默认）下全链路无外部依赖：不需要 ADALM2000、KiCad CLI、真实元器件库或 LLM key。

本地 Bridge（可选，P4 起需要）：

```bash
pnpm bridge:dev
```

数据库：

```bash
pnpm db:migrate && pnpm db:seed
```

无 Docker 时可直接用本机 PostgreSQL；有 Docker 则 `docker compose -f docker-compose.dev.yml up -d`。
Railway 上迁移与 seed 由 `apps/api/railway.json` 的 `preDeployCommand` 自动执行——
Railway Postgres 只有内网域名，本机连不上。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 健康检查（不带 `api/v1` 前缀） |
| `GET /api/v1/projects` | 项目列表 |
| `GET /api/v1/projects/:id` | 项目详情 + 统计 |
| `GET /api/v1/projects/:id/design` | 组件 / 网络 / 测试点 / 违规聚合 |
| `GET /api/v1/projects/:id/captures` | 8 条捕获（5 个场景 + 3 条早期） |
| `GET /api/v1/projects/:id/activity` | 调试记录时间线（由捕获/步骤/诊断派生） |
| `GET /api/v1/projects/:id/diagnoses/latest` | 最新 AI 诊断 |
| `GET /api/v1/projects/:id/debug-steps` | 调试计划树 |
| `GET /api/v1/projects/:id/photos` | 照片 + 视觉发现 + 标注 |
| `GET /api/v1/projects/:id/reports/latest` | 最新报告 |

| `POST /api/v1/ai/design-review` | 规则引擎 + AI 设计审查 |
| `POST /api/v1/ai/chat` | SSE 流式对话 |
| `POST /api/v1/ai/analyze-capture` | 波形诊断，落 AiDiagnosis |
| `POST /api/v1/ai/analyze-photo` | 视觉检测 |
| `POST /api/v1/ai/measure-guide` | 测量方案 |
| `POST /api/v1/projects/:id/kicad/upload` | 上传 KiCad zip 并解析 |
| `GET /api/v1/projects/:id/kicad/status` | 解析状态与 parseLog |
| `GET /api/v1/parts/search` `?q=` | 器件知识检索（pgvector → 关键词降级） |
| `POST /api/v1/auth/login` `GET /auth/me` | 简单登录（无密码，邮箱即账号） |
| 写操作 | 照片上传 / 标注 CRUD / 保存捕获 / 步骤流转 / 报告生成 |

写操作会校验项目归属：`userId` 为空的项目是公共 demo，未登录也能完整演示；
一旦项目归属某个用户，他人写入返回 401。

响应全部经 `@app/contracts` 的 Zod schema 校验后才返回。

## 接真实模型

```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=<你的 key>
LLM_CHAT_MODEL=gemini-2.5-flash      # 可选，默认即此
```

Claude 用 `ANTHROPIC_API_KEY`，DeepSeek 用 `DEEPSEEK_API_KEY`，或统一用 `LLM_API_KEY`。
**缺 key 不会报错**，自动降级为 mock，`GET /health` 的 `llm.degraded` 会标出来。

SDK import 只允许出现在 `packages/ai/src/providers/`，应用代码永远只见 `LlmProvider` 接口。

## 当前能力边界

| 能力 | 默认 | 真实路径 | 验证状态 |
| --- | --- | --- | --- |
| LLM | mock | Gemini / Claude / DeepSeek | ✅ Gemini 评测 11/11 |
| 对象存储 | 本地盘 | S3 / R2 / MinIO | ⚠️ 未接真实 bucket |
| KiCad 解析 | 包内 netlist | kicad-cli 全流程 | ⚠️ CLI 分支未在装 KiCad 的机器验证 |
| ADALM2000 | numpy 合成 | libm2k | ❌ **未接真实硬件** |
| 队列 | 无 Redis 同步兜底 | BullMQ | ✅ 两条路径都验证 |

降级从不静默：`GET /health` 报 `llm.degraded` 与 `storage.degraded`。
完整说明见 `docs/07-operations.md`。

## 公共 Demo 是只读的

未登录可完整浏览 6 个页面，但不能写。想动手就点「复制到我的项目」克隆一份
（邮箱即账号，无需密码）。早先允许匿名写，任何访客都能污染所有人看到的数据。

## 异步任务

```bash
pnpm --filter @app/worker dev    # 启动 worker
pnpm job kicad.parse '{...}'     # 手动入队；无 Redis 时直接本地跑
```

无 `REDIS_URL` 时 worker 空转、api 同步兜底，本地开发不必起 Redis。

## Bridge 配对

Bridge 只监听 127.0.0.1。控制类接口需要配对：网页点「连接本地 Bridge」，
Bridge 控制台会打印 6 位配对码。`/status` 与 `/emergency-stop` 不需要 token。

真实 ADALM2000 需要 libm2k + libiio，**尚未在硬件上验证**，见
`apps/m2k-bridge/README.md`。

## 智能体评测

```bash
pnpm test          # 单元测试（vitest），不需要数据库
pnpm test:agent    # 智能体黄金用例，需要 api 在跑
cd apps/m2k-bridge && pytest   # Bridge 安全与场景测试
```

docs/05 §14 的 12 条黄金用例。断言**结构与命中**而非措辞——诊断带受控的
`primaryCode`，所以「可排除削顶」这种否定语境不会被字符串匹配误判成误诊。

mock 基线 12/12；真实 Gemini 连跑三轮 11/11（1 条需本地 Bridge 跳过）。

真实 provider 接入暴露了 6 个 mock 基线看不见的缺陷，全部记录在
`docs/05-agent-design.md` §17 —— 没有一个是「模型不够聪明」，
全是契约、边界或防线本身的问题。

## 冒烟检查

```bash
pnpm smoke
```

生产环境：

```bash
API=https://api-production-bc7f.up.railway.app WEB=https://board-debug-copilot.vercel.app pnpm smoke
```

带上本地 Bridge 一起查：加 `BRIDGE=http://127.0.0.1:3777`。

检查覆盖全部 API 端点、6 个页面的 SSR 关键内容、规则引擎是否检出两条关键设计缺陷、
SSE 事件是否成流、Bridge 的危险操作是否被拦，以及写操作鉴权的运行时行为
（未登录不能写公共 Demo、克隆后能写自己的、不能写别人的）。

## 逐步接入真实依赖

三条命令见文首状态表。CI 里：`test:kicad-real` 跳过（runner 上没有 KiCad），
`test:storage-real` 有单独一个 job 用本地 MinIO 真跑，真实硬件那条只能人工跑。

macOS 上 kicad-cli 不在 PATH，要显式指过去：

```bash
export KICAD_CLI="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
pnpm test:kicad-real
```

## 本地 Bridge

调试工作台需要本机跑 Bridge（云端不碰 USB）。见 `apps/m2k-bridge/README.md`。
`BRIDGE_MOCK=true` 时无需 ADALM2000 硬件，用 numpy 合成五个故障场景的波形。

**`BRIDGE_MOCK=false` 是实验性真实硬件路径，目前未完成硬件验证。**
AWG 的实际输出频率、方波/三角波/锯齿波等波形类型、采集校准与量纲链路都需实机验证
（`square`/`triangle`/`sawtooth` 目前直接返回 `WAVEFORM_UNSUPPORTED`，不会静默按正弦输出）。
开启后 `/status` 返回 `hardwareVerified=false`，调试工作台显示「实验性硬件模式」横幅。
细节见 `apps/m2k-bridge/README.md` 的「真实硬件」一节。

## 目录结构

```
apps/web            Next.js App Router，6 个页面 + 元器件库
apps/api            NestJS，REST + SSE 流式 AI + AI Orchestrator
apps/worker         BullMQ，KiCad 解析 / ERC-DRC / BOM 匹配 / 报告生成
apps/m2k-bridge     Python FastAPI，只监听 127.0.0.1:3777（不进 turbo pipeline）
packages/db         Prisma schema + client
packages/contracts  Zod DTO / schema（前后端共享）
packages/ai         智能体：providers / context / evidence / tools / skills / guards
packages/kicad      工程解析 + 原理图规则引擎
packages/ui         跨页面复用组件
packages/instrument-protocol  Bridge 的 WS/REST 消息契约
```

## 文档

| 文档 | 内容 |
| --- | --- |
| `CLAUDE.md` | 项目记忆与硬性原则 |
| `docs/01-architecture.md` | 系统架构、部署拓扑、数据流 |
| `docs/02-data-model.md` | Prisma schema 全量定义 + Seed 规格 |
| `docs/03-ui-spec.md` | 6 个页面 UI 规格 |
| `docs/04-deploy.md` | Vercel / Railway 部署与环境变量 |
| `docs/05-agent-design.md` | 智能体设计（packages/ai 实施规格） |
| `docs/06-railway-setup.md` | Railway 服务与变量 |
| `docs/07-operations.md` | **运维手册：mock/real 边界、队列、存储、Bridge 配对** |
| `docs/08-real-kicad-validation.md` | 真实 KiCad 工程验证：fixture、`pnpm test:kicad-real`、已验证版本 |
| `docs/09-storage-validation.md` | 对象存储验证：MinIO / R2 / S3，以及生产为什么不能用 mock |
| `docs/10-adalm2000-hardware-validation.md` | ADALM2000 实机验证 checklist 与记录表 |
| `prompts/P0..P8` | 分阶段执行 Prompt |

## 关键开关

| 变量 | 说明 |
| --- | --- |
| `MOCK_MODE=true` | 全链路无外部依赖演示（默认） |
| `LLM_PROVIDER=gemini\|claude\|deepseek\|mock` | 模型切换，不改代码；缺 key 自动降级为 mock |
| `BRIDGE_MOCK=true` | 无 ADALM2000 硬件时合成波形；`false` 为**实验性、未实机验证**的真实硬件路径 |
| `STORAGE_ADAPTER=mock\|s3` | mock 落本地盘，s3 走对象存储。**生产必须 s3**，否则拒绝启动 |
| `ALLOW_MOCK_STORAGE_IN_PRODUCTION` | 生产用 mock 的显式豁免，只给内置 Demo（见 docs/09） |
| `KICAD_CLI` | kicad-cli 路径，留空从 PATH 找（macOS 上必须显式设） |
| `BRIDGE_REQUIRE_PAIRING=true` | 硬件控制端点要求配对 token |
| `BRIDGE_ALLOW_UNPAIRED_DEBUG` | 仅 CI/内置 Demo：放行 `/debug/scenario`，不放行 `/awg` |
| `BRIDGE_SCENARIO` | 五个故障场景，数值见 `docs/05` §11.1 |

## 实施进度

| Phase | 内容 | 状态 |
| --- | --- | --- |
| P0 | monorepo 骨架 + Shell + /health + 三平台上线 | ✅ |
| P1 | 数据库与 Seed + 只读端点 | ✅ |
| P2 | 项目总览页 | ✅ |
| P3 | 设计审查页 + 规则引擎 + AI 通道 | ✅ |
| P4 | M2K Bridge + 调试工作台 | ✅ |
| P5 | PCB 照片页 | ✅ |
| P6 | 调试计划页 | ✅ |
| P7 | 测试报告页 | ✅ |
| P8 | 部署上线 + 冒烟验收 | ✅ |
| — | 真实 LLM（Gemini/Claude/DeepSeek）+ 评测套件 | ✅ |
| — | 前端写操作 / KiCad zip 上传 / PDF·DOCX 导出 / pgvector | ✅ |

## 部署（已上线）

| 服务 | 平台 | 地址 |
| --- | --- | --- |
| web | Vercel | https://board-debug-copilot.vercel.app |
| api | Railway | https://api-production-bc7f.up.railway.app（`/health`、`/api/v1/projects`） |
| worker | Railway | 常驻进程，监听 BullMQ 队列 `bdc-jobs` |
| PostgreSQL / Redis | Railway | 内网 `postgres.railway.internal` / `redis.railway.internal` |

两侧都已连 GitHub，push 到 `main` 自动部署。
配置细节见 `docs/04-deploy.md` 与 `docs/06-railway-setup.md`。

## 已知环境坑

国内镜像（`registry.npmmirror.com`）缺 `@turbo/*` 平台二进制，可选依赖会被静默跳过，
导致 turbo 报 `did not find any binaries`。仓库 `.npmrc` 已把该 scope 指回官方源。
