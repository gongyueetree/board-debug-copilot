# 06 Railway 接入操作手册

> **状态：已接入完成**（2026-08-08）。本文保留为运维参考与重建步骤。
>
> | 资源 | 值 |
> | --- | --- |
> | Railway 项目 | `board-debug-copilot`（`gongyu-eetree's Projects`） |
> | 项目 ID | `90b2b29a-b40a-48ce-b063-57813715d573` |
> | 环境 | `production` = `ce85eca0-4f7c-4116-ac6b-e2d79c91d91b` |
> | api 服务 | `1121b9cc-e005-471a-aeff-2db00dd0b3d8` |
> | worker 服务 | `9cdc77c2-94e5-4148-bdc5-735114c28bd0` |
> | api 公网域名 | https://api-production-bc7f.up.railway.app |
> | 数据库 | Postgres + Redis（Railway 插件） |

Railway CLI 的登录是浏览器配对流程，必须由账号持有人本人完成一次。

## 1. 登录（一次性，需人工）

```bash
railway login
```

浏览器打开后授权即可。无浏览器环境用 `railway login --browserless`，把打印的
`https://railway.com/activate?user_code=XXXX-XXXX` 在任意设备打开。

验证：

```bash
railway whoami
```

## 2. 建项目与服务

```bash
cd board-debug-copilot
railway init --name board-debug-copilot
railway add --database postgres
railway add --database redis
```

pgvector（AI 检索用，P8 前可跳过）：

```bash
railway connect postgres
```

在 psql 里执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## 3. api 服务

新建服务并连 GitHub 仓库 `gongyueetree/board-debug-copilot`，然后：

| 设置项 | 值 |
| --- | --- |
| Root Directory | **`/`（仓库根）** |
| Config File Path | `apps/api/railway.json` |
| Watch Paths | `apps/api/**`, `packages/**`, `pnpm-lock.yaml`, `turbo.json` |

CLI 里没有这三项的直接命令，走 GraphQL：

```bash
railway api 'mutation($env:String!,$svc:String!,$input:ServiceInstanceUpdateInput!){
  serviceInstanceUpdate(environmentId:$env,serviceId:$svc,input:$input)}' \
  --raw-var "env=<ENV_ID>" --raw-var "svc=<SERVICE_ID>" \
  --var 'input={"railwayConfigFile":"apps/api/railway.json","rootDirectory":"/","watchPatterns":["apps/api/**","packages/**","pnpm-lock.yaml","turbo.json"]}'
```

`apps/api/railway.json` 已在仓库里，包含 build/start/healthcheck，无需手填命令。

环境变量：

```
NODE_ENV=production
MOCK_MODE=true
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
STORAGE_ADAPTER=mock
LLM_PROVIDER=mock
CORS_ORIGINS=https://board-debug-copilot.vercel.app,http://localhost:3000
```

Railway 会注入 `PORT`，`apps/api/src/main.ts` 已优先读它。

生成公网域名后回填到 Vercel：

```bash
vercel env add NEXT_PUBLIC_API_BASE_URL production
```

值为 `https://<api-service>.up.railway.app`，然后重新部署 web。

## 4. worker 服务

同上新建第二个服务，指向同一仓库：

| 设置项 | 值 |
| --- | --- |
| Root Directory | 留空（仓库根） |
| Config File Path | `apps/worker/railway.json` |
| Watch Paths | `apps/worker/**`, `packages/**` |

环境变量：`NODE_ENV` / `MOCK_MODE` / `DATABASE_URL` / `REDIS_URL`（同 api）。

worker 在缺 `REDIS_URL` 时降级空转，不会 crash-loop。

## 5. 数据库迁移（P1 之后）

```bash
railway run --service api pnpm db:migrate
railway run --service api pnpm db:seed
```

## 6. 验收

- `curl https://<api>.up.railway.app/health` 返回 200 且 `{"status":"ok"}`
- Vercel 生产站点可打开 6 个页面
- 本地起 mock bridge 后，调试工作台显示「已连接」

## 注意

- **不要**把 Root Directory 设成 `apps/api`。pnpm workspace 需要在仓库根安装，
  设成子目录会拿不到 `pnpm-lock.yaml` 与 `packages/*`。
- 构建命令用 `pnpm turbo build --filter=@app/api`，turbo 会先构建它依赖的
  `packages/*`（`dependsOn: ["^build"]`）。
- lockfile 已含 `@turbo/linux-64`，Linux 上不会重现本地那个「找不到 turbo 二进制」的问题。
