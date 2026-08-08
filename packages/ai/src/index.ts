/**
 * @app/ai — Board Debug Copilot 智能体
 *
 * 完整设计见 docs/05-agent-design.md。分层：
 *   L0 providers / L1 context / L2 evidence / L3 tools / L4 skills / L5 orchestrator / L6 guards
 *
 * apps/api 只用这里导出的东西，不感知内部分层。
 */
export type {
  ChatMessage,
  ChatOptions,
  LlmProvider,
  ProviderName,
  VisionImage,
} from './providers/base'
export { MockProvider } from './providers/mock'
export { GeminiProvider } from './providers/gemini'
export { ClaudeProvider } from './providers/claude'
export { DeepSeekProvider } from './providers/deepseek'
export { createProvider, describeProvider } from './providers/factory'

export { routeIntent } from './orchestrator/router'
export { runStructured, type StructuredRunResult } from './orchestrator/run'
export { GLOBAL_SYSTEM, SKILL_SYSTEM } from './prompts/system'
export { SKILLS, type SkillSpec } from './skills'
export { SCHEMA_HINTS, TASK_PROMPTS } from './skills/prompts'

export {
  dedupe,
  droppedRate,
  emptyStats,
  extractJson,
  ground,
  validate,
  type GroundingContext,
  type GuardStats,
} from './guards'

export const AI_PACKAGE_VERSION = '0.2.0'
