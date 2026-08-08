/**
 * @app/ai — Board Debug Copilot 智能体
 *
 * 完整设计见 docs/05-agent-design.md。分层：
 *   L0 providers / L1 context / L2 evidence / L3 tools / L4 skills / L5 orchestrator / L6 guards
 *
 * 对外只暴露两个入口，apps/api 不感知内部分层：
 *   runAgent(input)    非流式（worker / report）
 *   streamAgent(input) SSE
 */
export type { ChatMessage, ChatOptions, LlmProvider, VisionImage } from './providers/base'
export { MockProvider } from './providers/mock'
export { createProvider } from './providers/factory'

export const AI_PACKAGE_VERSION = '0.1.0'
