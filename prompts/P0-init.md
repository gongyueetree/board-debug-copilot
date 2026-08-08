# P0 初始化 Monorepo

阅读 CLAUDE.md 与 docs/01。执行：

1. pnpm workspace + Turborepo，TS/ESLint/Prettier 统一配置
2. 创建 apps/web（Next.js App Router + Tailwind + shadcn/ui 初始化，深色顶栏+左导航 Shell，7 个占位路由）
3. 创建 apps/api（NestJS，/health 端点），apps/worker（BullMQ 空 worker，可无 Redis 降级启动）
4. 创建 packages/db、contracts、ai、kicad、ui（空实现+index 导出）
5. apps/m2k-bridge 目录 + FastAPI main.py 骨架（/status 返回 mock）
6. 根 scripts：dev/build/lint/typecheck/db:generate/db:migrate/db:seed/db:studio
7. .env.example（docs/04 全量变量）、README（本地运行三步）

验收：pnpm dev 同时起 web/api；web 打开可见 Shell 与 6 个导航项；api /health 200。
