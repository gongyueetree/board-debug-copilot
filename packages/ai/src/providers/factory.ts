import type { LlmProvider } from './base'
import { ClaudeProvider } from './claude'
import { DeepSeekProvider } from './deepseek'
import { GeminiProvider } from './gemini'
import { MockProvider } from './mock'

/**
 * 按 LLM_PROVIDER 环境变量选择实现，切换模型不改应用代码。
 * MOCK_MODE=true 或缺 key 时一律降级到 MockProvider —— 演示环境永远不会因为
 * 少配一个变量就整页报错。
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const provider = (env.LLM_PROVIDER ?? 'mock').toLowerCase()

  if (env.MOCK_MODE === 'true' || provider === 'mock') return new MockProvider()

  switch (provider) {
    case 'gemini': {
      const key = env.GEMINI_API_KEY ?? env.LLM_API_KEY
      if (!key) return new MockProvider()
      return new GeminiProvider(
        key,
        env.LLM_CHAT_MODEL ?? 'gemini-2.5-flash',
        env.LLM_VISION_MODEL ?? env.LLM_CHAT_MODEL ?? 'gemini-2.5-flash',
      )
    }
    case 'claude': {
      const key = env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY
      if (!key) return new MockProvider()
      return new ClaudeProvider(key, env.LLM_CHAT_MODEL ?? 'claude-sonnet-4-6')
    }
    case 'deepseek': {
      const key = env.DEEPSEEK_API_KEY ?? env.LLM_API_KEY
      if (!key) return new MockProvider()
      return new DeepSeekProvider(key, env.LLM_CHAT_MODEL ?? 'deepseek-chat')
    }
    default:
      return new MockProvider()
  }
}

/** 供 /health 与日志展示，不暴露 key */
export function describeProvider(env: NodeJS.ProcessEnv = process.env) {
  const p = createProvider(env)
  return {
    provider: p.name,
    requested: (env.LLM_PROVIDER ?? 'mock').toLowerCase(),
    model: env.LLM_CHAT_MODEL ?? null,
    degraded: p.name === 'mock' && (env.LLM_PROVIDER ?? 'mock').toLowerCase() !== 'mock',
  }
}
