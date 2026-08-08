# P1 数据库与 Seed

阅读 docs/02。执行：

1. packages/db 落地完整 schema.prisma（关系不可改），migrate 通过
2. PrismaService 注入 NestJS；docker-compose.dev.yml 提供本地 PG(pgvector)+Redis
3. 实现 seed：完整写入 Sensor Board Debug Demo（组件/网络9条/引脚/违规18条/**5 条波形捕获（对应 5 个 scenario，默认展示 gain_error 波形#8）**/22步调试计划/视觉发现5条/报告1份），数据数值严格对齐 docs/02 Seed 一节与 docs/05 §11.1
4. contracts 包：为所有 API 响应定义 Zod schema（ProjectDetail、DesignBundle、CaptureSummary、DebugPlan、AiDiagnosis、DesignReview、VisualFindings、Report）
5. api 实现只读端点：GET /projects、GET /projects/:id、GET /projects/:id/design、/captures、/debug-steps、/photos、/reports/latest，全部返回 seed 数据并过 Zod 校验

验收：db:migrate+db:seed 成功；curl 各端点返回 Demo 数据；typecheck 全绿。
