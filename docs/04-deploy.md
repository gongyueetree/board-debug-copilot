# 04 部署与环境变量

## 部署决策
设计文档写 Vercel(web) + Railway(api)。结合前一项目经验（Railway 全栈因 WS/常驻进程）：

- **本项目浏览器⇄硬件的 WebSocket 走本地 Bridge（localhost），不经过云端**，因此前端放 Vercel 可行
- api 的 AI 流式回复用 **SSE**（NestJS 端点 `text/event-stream`），部署在 Railway 无限制
- **推荐方案 A**：web→Vercel，api+worker+PG+Redis→Railway
- **备选方案 B（与前一项目一致）**：全栈 Railway。若后续要做云端多人协同 WS，直接切 B
- 代码层不做任何平台耦合，两方案切换只改部署配置

## Railway 服务
```
railway 项目: board-debug-copilot
├── api      根目录 apps/api，start: node dist/main.js
├── worker   根目录 apps/worker
├── postgres 插件（启用 pgvector: CREATE EXTENSION vector）
└── redis    插件
```
Nixpacks/Dockerfile 二选一；monorepo 用根目录构建 + `pnpm --filter` 启动。

## 环境变量
```env
# 通用
NODE_ENV=production
MOCK_MODE=true              # 演示模式，全部 adapter 走 mock

# api / worker
DATABASE_URL=
REDIS_URL=
S3_ENDPOINT=  S3_REGION=  S3_BUCKET=  S3_ACCESS_KEY_ID=  S3_SECRET_ACCESS_KEY=
STORAGE_ADAPTER=mock        # mock | s3

LLM_PROVIDER=claude         # claude | deepseek | mock
LLM_API_KEY=
LLM_CHAT_MODEL=claude-sonnet-4-6
LLM_VISION_MODEL=
EMBEDDING_PROVIDER=mock
EMBEDDING_API_KEY=
EMBEDDING_MODEL=

# web (Vercel)
NEXT_PUBLIC_API_BASE_URL=https://api-xxx.up.railway.app
NEXT_PUBLIC_BRIDGE_URL=http://127.0.0.1:3777

# bridge（本地）
BRIDGE_ALLOWED_ORIGINS=http://localhost:3000,https://<vercel-domain>
BRIDGE_PAIRING_SECRET=
BRIDGE_MOCK=true
```

## 对象存储（生产必配）

Railway 容器无持久卷，`STORAGE_ADAPTER=mock` 重启即丢。生产用 R2 或 S3：

```env
STORAGE_ADAPTER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # R2；AWS 留空
S3_REGION=auto                                              # AWS 填真实 region
S3_BUCKET=board-debug-copilot
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true                                    # R2/MinIO true，AWS false
```

### ⚠️ 生产不允许 mock 存储

`NODE_ENV=production` + 实际生效的 adapter 是 mock + 没有显式豁免 →
**api 与 worker 拒绝启动**，日志第一行就是该配什么。

配置不全（比如少填 `S3_BUCKET`）会降级为 mock —— 在开发环境只是
`/health` 的 `storage.degraded=true`，在生产环境就是启动失败。

内置 Demo 这种明知故犯的场景用显式豁免：

```env
ALLOW_MOCK_STORAGE_IN_PRODUCTION=true
```

豁免后能启动，但 `storage.degraded` 仍是 `true`。

> **已经部署过的服务注意**：这条校验是后加的。如果 Railway 上的 api / worker
> 目前跑在 `NODE_ENV=production` 且没配 S3，**下一次部署会起不来** ——
> 二选一：配好上面那组 `S3_*`，或者先加 `ALLOW_MOCK_STORAGE_IN_PRODUCTION=true`。

验证真实存储：`pnpm test:storage-real`（本地 MinIO 一条命令起，见
`docs/09-storage-validation.md`）。

完整运维说明见 `docs/07-operations.md`。

## 注意事项（历史经验）
- GitHub 账号是 `gongyueetree`，push 前确认 remote
- zsh 命令不要带中文行内注释
- Vercel 上 Next.js 需把 `packages/*` 加入 transpilePackages
- CORS：api 允许 Vercel 域名；Bridge 只允许配置的 origins 且只绑 127.0.0.1
- 混合内容：https 前端连 `ws://127.0.0.1` 在 Chrome 允许（localhost 豁免），文档中向用户说明需用 Chrome/Edge
- `AUTH_SECRET` 生产必配，否则每次重启登录态全失效
- `REDIS_URL` 生产必配，否则大工程解析在请求里同步跑会被网关超时掐断
- `BRIDGE_REQUIRE_PAIRING` 不要在生产关掉
- `BRIDGE_ALLOW_UNPAIRED_DEBUG` 同理，只给 CI 与内置 Demo；开着时调试工作台会显示警示条
- `STORAGE_ADAPTER=mock` 在 `NODE_ENV=production` 下会直接拒绝启动，见上

## 本地开发
```
pnpm i
pnpm db:migrate && pnpm db:seed
pnpm dev                    # web:3000 api:3001 worker
cd apps/m2k-bridge && uvicorn src.main:app --port 3777   # BRIDGE_MOCK=true
```

## 验收（部署阶段）
- Vercel 生产域名可打开 6 个页面，Demo 数据完整
- Railway api /health 200，SSE 聊天可流式返回
- 本地起 mock bridge 后，调试工作台显示「已连接」并出实时波形
