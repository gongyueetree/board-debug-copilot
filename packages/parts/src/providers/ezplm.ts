import { randomUUID } from 'node:crypto'
import type { ParametricQuery, RawAlternate, RawPart } from '../types'
import { normalizeMpn } from '../normalize/mpn'
import { PartsError, type PartsCapabilities, type PartsProvider } from './base'
import { canonicalQuery, signRequest } from './ezplm-signing'

/**
 * ezPLM 系统库查询接口。**唯一允许写 fetch 的地方。**
 *
 * ── 这不是「110 万通用器件库」 ──────────────────────────────
 * 手册原文：「仅返回当前白名单内的供应商物料与其参考设计」。它是 ezPLM 的
 * 系统库，数据范围由白名单决定，不是一个通用元器件百科。对我们的影响：
 *
 *   - 匹配率取决于「用户 BOM 里的器件在不在白名单供应商里」，而不是库有多大
 *   - 只有两个端点：物料查询 + 参考设计查询
 *   - **没有** 批量查、类目树、替代料、参数化检索
 *   - 返回字段里**没有 category** —— 类目只能从 mpn/description 推断
 *
 * 它有一个方案里没算到的能力：**参考设计**。一颗芯片的官方参考电路，对
 * 「你的设计和参考设计差在哪」这类问题比参数表更直接。见 getReferenceDesigns。
 *
 * 配额是按天算的（超了 429），而不是按 QPS —— 所以 batchGetByMpn 用串行
 * 而不是并发：并发只会更快耗尽当天的额度，不会拿到更多数据。
 */

export const EZPLM_BASE_URL = 'https://www.ezplm.cn'

const PATH_PARTS = '/api/v1/api-key/parts'
const PATH_REFERENCE_DESIGNS = '/api/v1/api-key/reference-designs'

export interface EzplmConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  /** 单次分页大小；手册没写上限，保守取 50 */
  pageSize: number
}

export interface EzplmReferenceDesign {
  name?: string
  link?: string
  image?: string | null
  description?: string
}

interface PagedResponse {
  data?: unknown[]
  meta?: Record<string, unknown>
}

/**
 * 从 meta 里找下一页游标。
 *
 * 手册只写了「data + meta 的分页结构」，没给 meta 的字段名。这里按常见命名
 * 逐个试，**一个都没命中就停止翻页**而不是死循环 —— 翻页翻不动比翻页翻不完好。
 */
function nextCursorOf(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null
  for (const k of ['nextCursor', 'next_cursor', 'cursor', 'nextPageCursor', 'next']) {
    const v = meta[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

export class EzplmPartsProvider implements PartsProvider {
  readonly name = 'remote' as const

  /**
   * 按接口**实际**能力置位，不按我们希望它有的能力。
   *
   * `exactLookup: false` 是有意的：只有关键词搜索，没有按 MPN 精确查的端点。
   * 我们在 getByMpn 里用 keyword 搜再自己筛精确匹配 —— 能用，但那是我们拼的，
   * 不是接口给的，所以能力声明必须诚实。上游据此知道 L1 的结果不如真正的
   * 精确查可靠。
   */
  readonly capabilities: PartsCapabilities = {
    exactLookup: false,
    keywordSearch: true,
    batchLookup: false,
    alternates: false,
    lifecycle: false,
    parametric: false,
  }

  private lastError: string | null = null
  private lastLatencyMs = 0

  constructor(private readonly config: EzplmConfig) {}

  private async request(path: string, params: Record<string, string | number | undefined>) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID()
    const signature = signRequest({
      apiKey: this.config.apiKey,
      method: 'GET',
      path,
      params,
      timestamp,
      nonce,
    })
    // 签名用的串和 URL 用的串必须是同一份 —— 分别构造是这类签名最常见的翻车点
    const query = canonicalQuery(params)
    const url = `${this.config.baseUrl}${path}${query ? `?${query}` : ''}`

    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-API-Key': this.config.apiKey,
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': signature,
        },
        signal: ctrl.signal,
      })
      this.lastLatencyMs = Date.now() - started

      if (!res.ok) throw this.toError(res.status, await res.text())

      const body = (await res.json()) as PagedResponse
      this.lastError = null
      return body
    } catch (err) {
      if (err instanceof PartsError) {
        this.lastError = `${err.code}: ${err.message}`
        throw err
      }
      const aborted = err instanceof Error && err.name === 'AbortError'
      const e = new PartsError(
        aborted ? `请求超时（${this.config.timeoutMs}ms）：${path}` : `请求失败：${String(err)}`,
        aborted ? 'TIMEOUT' : 'UPSTREAM',
        true,
      )
      this.lastError = `${e.code}: ${e.message}`
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** 手册 §5 的错误码表 */
  private toError(status: number, body: string): PartsError {
    const snippet = body.slice(0, 200)
    if (status === 400) {
      return new PartsError(
        `参数或签名头有误（400）：检查四个签名头是否齐全、query 格式是否正确。${snippet}`,
        'BAD_RESPONSE',
      )
    }
    if (status === 401) {
      return new PartsError(
        `签名校验失败（401）：X-Signature 不正确，或 X-Nonce 被重复使用。${snippet}`,
        'UNAUTHORIZED',
      )
    }
    if (status === 404) {
      return new PartsError(`资源不存在（404）：partlibId 可能不正确。${snippet}`, 'BAD_RESPONSE')
    }
    if (status === 429) {
      // 配额是按天的，不是按秒 —— 重试没有意义，退避到明天才有意义
      return new PartsError(
        `当天调用次数已达上限（429）。需等到次日或找管理员重置。${snippet}`,
        'RATE_LIMITED',
        false,
      )
    }
    return new PartsError(`上游返回 ${status}：${snippet}`, 'UPSTREAM', status >= 500)
  }

  /**
   * 按 MPN 取器件。
   *
   * 接口没有精确查端点，所以用 keyword 搜再自己筛。归一化后相等才算命中 ——
   * 搜 `AD8605` 会返回一堆 `AD8605ARZ` / `AD8605AUJZ`，直接取第一条就是错的。
   * 筛不出精确匹配就返回 null，交给上游的 L2 前缀层处理。
   */
  async getByMpn(mpn: string): Promise<RawPart | null> {
    const target = normalizeMpn(mpn)
    const body = await this.request(PATH_PARTS, { keyword: mpn, pageSize: this.config.pageSize })
    const items = Array.isArray(body.data) ? (body.data as RawPart[]) : []
    return (
      items.find((it) => {
        const raw = it.mpn
        return typeof raw === 'string' && normalizeMpn(raw) === target
      }) ?? null
    )
  }

  /**
   * 批量查询。**串行，不并发。**
   *
   * 配额按天算（手册 §5：429 = 当天次数用完），并发只会更快耗尽额度，
   * 拿不到更多数据。一条失败不影响其余 —— BOM 里一个查不到的器件不该让
   * 整批回填崩掉。
   */
  async batchGetByMpn(mpns: string[]): Promise<Map<string, RawPart>> {
    const out = new Map<string, RawPart>()
    for (const m of mpns) {
      try {
        const hit = await this.getByMpn(m)
        if (hit) out.set(normalizeMpn(m), hit)
      } catch (err) {
        if (err instanceof PartsError && err.code === 'RATE_LIMITED') throw err // 配额没了，继续没意义
        // 其余错误记下来继续：失败留痕但不阻断整批
        this.lastError = err instanceof PartsError ? `${err.code}: ${err.message}` : String(err)
      }
    }
    return out
  }

  async searchByKeyword(q: string, opts?: { limit?: number }): Promise<RawPart[]> {
    const body = await this.request(PATH_PARTS, {
      keyword: q,
      pageSize: Math.min(opts?.limit ?? this.config.pageSize, this.config.pageSize),
    })
    return Array.isArray(body.data) ? (body.data as RawPart[]) : []
  }

  /** 接口不支持参数化检索，capabilities.parametric=false，上游不该调到这里 */
  async searchParametric(_q: ParametricQuery): Promise<RawPart[]> {
    throw new PartsError('ezPLM 接口不支持参数化检索', 'NOT_CONFIGURED')
  }

  /** 接口没有替代料端点。上游据 capabilities.alternates=false 走本地兜底。 */
  async getAlternates(_mpn: string): Promise<RawAlternate[]> {
    throw new PartsError('ezPLM 接口不提供替代料', 'NOT_CONFIGURED')
  }

  /**
   * 参考设计 —— 方案里没算到的能力。
   *
   * 一颗芯片的官方参考电路，对「你的设计和参考设计差在哪」这类问题比参数表
   * 更直接。`partlibId` 来自 parts 接口返回的 `id`，调用顺序是固定的。
   */
  async getReferenceDesigns(partlibId: string, limit = 10): Promise<EzplmReferenceDesign[]> {
    const body = await this.request(PATH_REFERENCE_DESIGNS, {
      partlibId,
      pageSize: Math.min(limit, this.config.pageSize),
    })
    const items = Array.isArray(body.data) ? body.data : []
    return items
      .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
      .map((it) => ({
        name: typeof it.name === 'string' ? it.name : undefined,
        link: typeof it.link === 'string' ? it.link : undefined,
        image: typeof it.image === 'string' ? it.image : null,
        description: typeof it.description === 'string' ? it.description : undefined,
      }))
  }

  /**
   * 翻页取全量。手册没给 meta 的字段名，nextCursorOf 认不出游标就停 ——
   * **翻不动好过翻不完**：死循环会把当天配额一次烧光。
   */
  async searchAllPages(keyword: string, maxPages = 5): Promise<RawPart[]> {
    const out: RawPart[] = []
    let cursor: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const body: PagedResponse = await this.request(PATH_PARTS, {
        keyword,
        pageSize: this.config.pageSize,
        ...(cursor ? { cursor } : {}),
      })
      const items = Array.isArray(body.data) ? (body.data as RawPart[]) : []
      out.push(...items)
      cursor = nextCursorOf(body.meta)
      if (!cursor || items.length === 0) break
    }
    return out
  }

  async health() {
    // 不主动打一次请求：配额按天算，健康检查不该白白消耗它。
    // 报最近一次真实调用的结果，没调过就是「未知但未降级」。
    return {
      degraded: this.lastError !== null,
      lastError: this.lastError,
      latencyMs: this.lastLatencyMs,
    }
  }
}

export const __testing = { nextCursorOf }
