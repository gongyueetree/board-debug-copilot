import type { ParametricQuery, RawAlternate, RawPart } from '../types'
import { PartsError, type PartsCapabilities, type PartsProvider } from './base'

/**
 * 110 万器件库 HTTP 适配。**唯一允许写 fetch 的文件。**
 *
 * 与 packages/ai 里「SDK import 只允许出现在 providers/」同一条纪律：
 * 远端字段长什么样、分页怎么翻、鉴权怎么做，只影响这个文件与 mapping/。
 *
 * ── 当前状态：未配置 ──────────────────────────────────────────
 * 技术方案 §2.2 列了九项参考信息，一项都还没拿到。**这里不猜。**
 * 猜出来的字段映射会安静地产出错误参数，而错误的 vsAbsMax 会让 AI 得出
 * 一个看起来极其笃定的错误根因 —— 比查不到危险得多。
 *
 * 所以：缺参考文件时每个方法都抛 NOT_CONFIGURED，由 PartsService 降级到
 * 镜像 / mock，并在 /health 的 parts.missingSpec 里把缺什么列出来。
 *
 * 拿到参考文件后要做的事，按顺序：
 *   1. 填 MISSING_SPEC 对应的常量（ENDPOINTS / AUTH / PAGING / RATE_LIMIT）
 *   2. 把 mapping/field-map.ts 的 FIELD_PATHS 换成真实字段名
 *   3. 把 mapping/category-map.ts 的 EXPLICIT_CATEGORY_MAP 填上类目字典
 *   4. 删掉 assertConfigured() 的调用
 *   5. 跑 scripts/backfill-parts.ts --dry-run 看分层匹配率
 */

/** §2.2 的九项。填一项删一项，全空说明一项都没拿到。 */
export const MISSING_SPEC = [
  'baseUrl: Base URL 与环境区分',
  'auth: 鉴权方式（Header / 签名 / 有效期 / 刷新）',
  'endpoints: MPN 精确查 / 关键词模糊查 / 批量查 / 类目树 / 替代料',
  'paging: 分页与总量约定',
  'fields: 完整字段字典（含义、类型、单位、可空性）',
  'samples: 至少 3 条真实响应（阻容 / IC / 空结果）',
  'rateLimit: QPS、并发、日配额',
  'errorCodes: 错误码表',
  'categories: 类目字典',
] as const

export interface RemoteConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  batchSize: number
  maxConcurrency: number
}

/** 指数退避：429 与 5xx 才重试，4xx（除 429）重试没有意义 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!(err instanceof PartsError) || !err.retryable) throw err
      if (i === attempts - 1) break
      // 200ms → 400ms → 800ms
      await new Promise((r) => setTimeout(r, 200 * 2 ** i))
    }
  }
  throw lastErr
}

/** 分片 + 并发上限。BOM 一次上百行，不做这个第一次真实解析就会被限流打回。 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export class RemotePartsProvider implements PartsProvider {
  readonly name = 'remote' as const

  /**
   * 参考文件到位之前，能力一律 false。
   * 上游据此走本地兜底而不是拿到空数组以为「远端说没有」。
   */
  readonly capabilities: PartsCapabilities = {
    exactLookup: false,
    keywordSearch: false,
    batchLookup: false,
    alternates: false,
    lifecycle: false,
    parametric: false,
  }

  constructor(private readonly config: RemoteConfig) {}

  private assertConfigured(): never {
    throw new PartsError(
      `器件库 API 尚未接入：缺少 ${MISSING_SPEC.length} 项接入信息。` +
        `见 docs/11-parts-database.md 与 packages/parts/src/providers/remote.ts 的说明`,
      'NOT_CONFIGURED',
    )
  }

  async getByMpn(_mpn: string): Promise<RawPart | null> {
    this.assertConfigured()
  }

  async batchGetByMpn(_mpns: string[]): Promise<Map<string, RawPart>> {
    this.assertConfigured()
  }

  async searchByKeyword(_q: string): Promise<RawPart[]> {
    this.assertConfigured()
  }

  async searchParametric(_q: ParametricQuery): Promise<RawPart[]> {
    this.assertConfigured()
  }

  async getAlternates(_mpn: string): Promise<RawAlternate[]> {
    this.assertConfigured()
  }

  async health() {
    return {
      degraded: true,
      lastError: `未接入：缺 ${MISSING_SPEC.length} 项接入信息`,
      latencyMs: 0,
    }
  }
}

// 留给接入时用，现在没有调用方；导出以免被 TS 判成未使用
export const __internals = { withRetry }
