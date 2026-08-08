# P8 部署上线

阅读 docs/04。执行：

1. 仓库推送 eehubio/board-debug-copilot（确认 git remote 账号）
2. Railway：api/worker 服务 + PG(启用 pgvector) + Redis，配置 env，跑 migrate+seed
3. Vercel：apps/web，transpilePackages 配置，env 指向 Railway api
4. CORS/SSE 生产验证；Bridge 打包脚本（PyInstaller spec + README 用户指引：下载→运行→浏览器连接）
5. 冒烟清单自动化：scripts/smoke.ts 依次请求全部端点+页面 SSR
6. README 完整化：架构图、本地运行、部署步骤、MOCK_MODE 说明、Bridge 使用说明

验收：生产域名 6 页全通；MOCK_MODE=true 全链路演示；本地 Bridge 连生产前端出波形。
