# Board Debug Copilot（准 LabSight 原型）

工程师上传 KiCad 工程 + PCB 照片，通过本地 ADALM2000 Bridge 采集测量数据，
AI 智能体综合**设计上下文 + 元器件知识 + 测量数据 + 视觉信息**，
输出设计审查、调试计划、故障诊断和调试报告。

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

## 智能体评测

```bash
pnpm test:agent
```

docs/05 §14 的 12 条黄金用例。断言**结构与命中**而非措辞——诊断带受控的
`primaryCode`，所以「可排除削顶」这种否定语境不会被字符串匹配误判成误诊。

mock 基线 12/12。换真实 provider 重跑即可看出守卫管线在真实输出上的表现。

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
SSE 事件是否成流、Bridge 的危险操作是否被拦。

## 本地 Bridge

调试工作台需要本机跑 Bridge（云端不碰 USB）。见 `apps/m2k-bridge/README.md`。
`BRIDGE_MOCK=true` 时无需 ADALM2000 硬件，用 numpy 合成五个故障场景的波形。

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
| `prompts/P0..P8` | 分阶段执行 Prompt |

## 关键开关

| 变量 | 说明 |
| --- | --- |
| `MOCK_MODE=true` | 全链路无外部依赖演示（默认） |
| `LLM_PROVIDER=gemini\|claude\|deepseek\|mock` | 模型切换，不改代码；缺 key 自动降级为 mock |
| `BRIDGE_MOCK=true` | 无 ADALM2000 硬件时合成波形 |
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
