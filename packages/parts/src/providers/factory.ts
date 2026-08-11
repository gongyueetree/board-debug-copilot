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
/**
 * 变量别名。
 *
 * 手册与联调步骤里用的是 `EZPLM_*`，而 adapter 层用的是与 provider 无关的
 * `PARTS_*`。两套都认，`PARTS_*` 优先 —— 否则「我设了 EZPLM_API_KEY
 * 但什么都没发生」会浪费掉一整轮联调。
 */
function pick(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

export function createPartsProvider(env: NodeJS.ProcessEnv = process.env): PartsProviderInfo {
  const requested = env.PARTS_PROVIDER ?? 'mock'
  const apiKey = pick(env, 'PARTS_API_KEY', 'EZPLM_API_KEY')

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
      // 设了 key 却没开 remote 是最容易白跑一轮的配置错误：
      // 一切正常，只是数据仍然来自内置那 5 颗器件。所以要说出来。
      reason: apiKey ? '已配置 API Key，但 PARTS_PROVIDER 不是 remote，仍在用内置常识参数' : null,
      missingSpec: [],
    }
  }

  if (!apiKey) {
    return {
      provider: new MockPartsProvider(),
      requested,
      degraded: true,
      reason: 'PARTS_PROVIDER=remote 但缺 PARTS_API_KEY（或 EZPLM_API_KEY），已降级为 mock',
      missingSpec: [...MISSING_SPEC],
    }
  }

  return {
    provider: new EzplmPartsProvider({
      // base URL 有默认值：手册写死了 www.ezplm.cn，不该逼每个环境都配一遍
      baseUrl: (pick(env, 'PARTS_API_BASE_URL', 'EZPLM_BASE_URL') ?? EZPLM_BASE_URL).replace(/\/$/, ''),
      apiKey,
      timeoutMs: Number(pick(env, 'PARTS_TIMEOUT_MS', 'EZPLM_TIMEOUT_MS')) || 15_000,
      pageSize: Number(pick(env, 'PARTS_PAGE_SIZE', 'EZPLM_PAGE_SIZE')) || 50,
    }),
    requested,
    // 能用，但接入信息仍不完整 —— degraded 留 false（它确实在工作），
    // 缺口通过 missingSpec 单独显形，两件事不该混成一个布尔。
    degraded: false,
    reason: null,
    missingSpec: [...MISSING_SPEC],
  }
}
