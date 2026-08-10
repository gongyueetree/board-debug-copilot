import type { PartsProvider } from './base'
import { MockPartsProvider } from './mock'
import { MISSING_SPEC, RemotePartsProvider } from './remote'

export interface PartsProviderInfo {
  provider: PartsProvider
  requested: string
  degraded: boolean
  reason: string | null
  missingSpec: string[]
}

/**
 * 按 PARTS_PROVIDER 选 provider，缺配置自动降级 mock。
 *
 * 与 createStorage / createLlmProvider 同构：**降级从不静默**，
 * 调用方通过 describeParts() 能看到降级原因，/health 会报出来。
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

  const baseUrl = env.PARTS_API_BASE_URL
  const apiKey = env.PARTS_API_KEY
  if (!baseUrl || !apiKey) {
    return {
      provider: new MockPartsProvider(),
      requested,
      degraded: true,
      reason: 'PARTS_PROVIDER=remote 但缺 PARTS_API_BASE_URL / PARTS_API_KEY，已降级为 mock',
      missingSpec: [...MISSING_SPEC],
    }
  }

  // 参考文件未到位：remote 能构造，但每个方法都抛 NOT_CONFIGURED。
  // 仍然返回它而不是直接换 mock —— 让 /health 如实显示「请求的是 remote，
  // 但它不可用」，而不是假装配置成功了。
  return {
    provider: new RemotePartsProvider({
      baseUrl,
      apiKey,
      timeoutMs: Number(env.PARTS_TIMEOUT_MS) || 15_000,
      batchSize: Number(env.PARTS_BATCH_SIZE) || 50,
      maxConcurrency: Number(env.PARTS_MAX_CONCURRENCY) || 4,
    }),
    requested,
    degraded: MISSING_SPEC.length > 0,
    reason: MISSING_SPEC.length > 0 ? `器件库 API 接入信息缺 ${MISSING_SPEC.length} 项` : null,
    missingSpec: [...MISSING_SPEC],
  }
}
