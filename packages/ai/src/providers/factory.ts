import type { LlmProvider } from './base'
import { MockProvider } from './mock'

/**
 * 按 LLM_PROVIDER 环境变量选择实现，切换模型不改应用代码。
 * MOCK_MODE=true 或缺 API key 时一律降级到 MockProvider。
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const mockMode = env.MOCK_MODE === 'true'
  const provider = (env.LLM_PROVIDER ?? 'mock').toLowerCase()

  if (mockMode || provider === 'mock' || !env.LLM_API_KEY) {
    return new MockProvider()
  }

  // P3 接入 ClaudeProvider / DeepSeekProvider（同样只在本文件内 import SDK）
  throw new Error(
    `LLM_PROVIDER=${provider} 尚未实现（P3 落地）。当前请设 MOCK_MODE=true 或 LLM_PROVIDER=mock。`,
  )
}
