import type { PartsProvider } from './base'
import { EzplmPartsProvider, EZPLM_BASE_URL } from './ezplm'
import { MockPartsProvider } from './mock'
import { MISSING_SPEC } from './remote'

export interface PartsProviderInfo {
  provider: PartsProvider
  requested: string
  degraded: boolean
  reason: string | null
  /** 仍然缺的接入信息。不阻塞接入，但会限制能力，所以要在 /health 显形。 */
  missingSpec: string[]
}

/**
 * 按 PARTS_PROVIDER 选 provider，缺配置自动降级 mock。
 *
 * 与 createStorage / createLlmProvider 同构：**降级从不静默**，
 * 调用方通过 describe() 能看到降级原因，/health 会报出来。
 */
export function createPartsProvider(env: NodeJS.ProcessEnv = process.env): PartsProviderInfo {
  const requested = env.PARTS_PROVIDER ?? 'mock'

  // 硬性原则 #2：MOCK_MODE 下禁止发起任何真实请求
  if (env.MOCK_MODE === 'true' && requested === 'remote') {
    return {
      provider: new MockPartsProvider(),
      requested,
      degraded: true,
      reason: 'MOCK_MODE=true 时不允许走远端器件库',
      missingSpec: [],
    }
  }

  if (requested !== 'remote') {
    return {
      provider: new MockPartsProvider(),
      requested,
      degraded: false,
      reason: null,
      missingSpec: [],
    }
  }

  const apiKey = env.PARTS_API_KEY
  if (!apiKey) {
    return {
      provider: new MockPartsProvider(),
      requested,
      degraded: true,
      reason: 'PARTS_PROVIDER=remote 但缺 PARTS_API_KEY，已降级为 mock',
      missingSpec: [...MISSING_SPEC],
    }
  }

  return {
    provider: new EzplmPartsProvider({
      // base URL 有默认值：手册写死了 www.ezplm.cn，不该逼每个环境都配一遍
      baseUrl: (env.PARTS_API_BASE_URL || EZPLM_BASE_URL).replace(/\/$/, ''),
      apiKey,
      timeoutMs: Number(env.PARTS_TIMEOUT_MS) || 15_000,
      pageSize: Number(env.PARTS_PAGE_SIZE) || 50,
    }),
    requested,
    // 能用，但接入信息仍不完整 —— degraded 留 false（它确实在工作），
    // 缺口通过 missingSpec 单独显形，两件事不该混成一个布尔。
    degraded: false,
    reason: null,
    missingSpec: [...MISSING_SPEC],
  }
}
