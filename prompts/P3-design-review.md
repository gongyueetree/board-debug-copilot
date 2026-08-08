# P3 设计审查页 + 规则引擎 + AI 通道

阅读 docs/03「页面2」、docs/01 规则引擎与 AI 架构、**docs/05 智能体设计（§2 分层 / §4 上下文 / §6 工具 / §7 输出契约 / §9 守卫 / §10 SSE）**。执行：

1. packages/kicad：mock parser（读 seed，不解析真实文件）+ 规则引擎（原理图 10 条规则，输出 RuleViolation）
2. packages/ai：Provider 接口 + MockProvider + ClaudeProvider + DeepSeekProvider（env 切换，应用代码零直连 SDK）；AgentRouter + design_review agent，输出过 DesignReviewSchema
3. api：POST /ai/chat（SSE 流式）、POST /ai/design-review
4. 设计审查页三栏：组件筛选树/已选组件详情、原理图 SVG 查看器(缩放平移、选中描边、网络高亮开关)、右侧 AI 审查面板(风险卡流+BOM/ERC 小结卡)
5. MOCK_MODE 下 AI 面板返回 seed 预置审查结果；配真实 key 时走 LLM

验收：三栏交互完整；SSE 在浏览器可见流式输出；切换 LLM_PROVIDER 不改代码。
