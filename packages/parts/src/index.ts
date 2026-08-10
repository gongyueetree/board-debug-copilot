import { toNormalizedPart } from './mapping/field-map'
import { matchComponent, type MatchDeps } from './match'
import { LruCache } from './cache/memory'
import { Mirror, type MirrorStore } from './cache/mirror'
import { normalizeMpn } from './normalize/mpn'
import { PartsError, type PartsProvider } from './providers/base'
import { createPartsProvider, type PartsProviderInfo } from './providers/factory'
import { EzplmPartsProvider, type EzplmReferenceDesign } from './providers/ezplm'
import type {
  ComponentLike,
  MatchResult,
  NormalizedPart,
  PartCategory,
  PartsHealth,
  RawAlternate,
} from './types'

export * from './types'
export { PartsError } from './providers/base'
export type { PartsCapabilities, PartsProvider } from './providers/base'
export { normalizeMpn, mpnPrefixCandidates, sharesFamily } from './normalize/mpn'
export { extractParams, paramCompleteness, PARAM_WHITELIST } from './normalize/params'
export { parseQuantity, normalizePackage } from './mapping/unit'
export { mapCategory, guessCategoryFromRef } from './mapping/category-map'
export { matchComponent, type MatchDeps } from './match'
export {
  AUTO_ACCEPT_THRESHOLD,
  CONFIDENCE_RANGE,
  isAutoAccepted,
  statusFor,
} from './match/scoring'
export { LruCache } from './cache/memory'
export { Mirror, type MirrorStore } from './cache/mirror'
export {
  chunk,
  mapWithConcurrency,
  MISSING_SPEC,
  RESOLVED_SPEC,
  DEFAULT_REMOTE_BASE_URL,
} from './providers/remote'
export {
  EzplmPartsProvider,
  EZPLM_BASE_URL,
  type EzplmConfig,
  type EzplmReferenceDesign,
} from './providers/ezplm'
export { canonicalQuery, canonicalRequest, signRequest } from './providers/ezplm-signing'
export { createPartsProvider, type PartsProviderInfo } from './providers/factory'

export interface PartsServiceOptions {
  env?: NodeJS.ProcessEnv
  /** Postgres 镜像；不给就只有 LRU + provider 两级 */
  mirror?: MirrorStore
  /** 向量检索，L4 用；不给就没有 L4 */
  byVector?: (text: string) => Promise<{ part: NormalizedPart; cosine: number }[]>
}

/**
 * 对外唯一入口。**不导出 provider** —— 调用方不该知道数据来自远端还是内置。
 *
 * 三级读取：进程内 LRU → Postgres 镜像（过期先返回旧值）→ 远端 API。
 * 降级链：远端不可用 → 镜像（即使过期）→ mock 内置常识参数 → 标 degraded。
 */
export class PartsService {
  private readonly info: PartsProviderInfo
  private readonly provider: PartsProvider
  private readonly lru = new LruCache<NormalizedPart | null>(2000, 60_000)
  private readonly mirror: Mirror | null
  private readonly byVector?: PartsServiceOptions['byVector']
  private readonly latencies: number[] = []
  private lastError: string | null = null

  constructor(private readonly opts: PartsServiceOptions = {}) {
    const env = opts.env ?? process.env
    this.info = createPartsProvider(env)
    this.provider = this.info.provider
    this.mirror = opts.mirror
      ? new Mirror(opts.mirror, Number(env.PARTS_CACHE_TTL_DAYS) || 7)
      : null
    this.byVector = opts.byVector
  }

  get capabilities() {
    return this.provider.capabilities
  }

  /** 按 MPN 取器件。查不到返回 null —— 不要为了「有个结果」编一个。 */
  async getByMpn(rawMpn: string): Promise<NormalizedPart | null> {
    const mpn = normalizeMpn(rawMpn)
    if (!mpn) return null

    const cached = this.lru.get(mpn)
    if (cached !== undefined) return cached

    let part: NormalizedPart | null = null

    if (this.mirror) {
      part = await this.mirror.get(mpn, (m) => this.fetchRemote(m))
    }
    if (!part) {
      part = await this.fetchRemote(mpn)
      if (part && this.mirror) await this.mirror.put(part).catch(() => {})
    }

    this.lru.set(mpn, part)
    return part
  }

  private async fetchRemote(mpn: string): Promise<NormalizedPart | null> {
    const started = Date.now()
    try {
      const raw = await this.provider.getByMpn(mpn)
      this.record(Date.now() - started)
      if (!raw) return null
      const part = toNormalizedPart(raw, this.provider.name)
      if (!part) return null
      part.source.fetchedAt = new Date().toISOString()
      return part
    } catch (err) {
      // 失败必须留痕：记下来让 /health 报出去，不要静默吞掉
      this.lastError = err instanceof PartsError ? `${err.code}: ${err.message}` : String(err)
      this.record(Date.now() - started)
      return null
    }
  }

  private record(ms: number): void {
    this.latencies.push(ms)
    if (this.latencies.length > 200) this.latencies.shift()
  }

  async searchByKeyword(q: string, opts?: { limit?: number }): Promise<NormalizedPart[]> {
    try {
      const raws = await this.provider.searchByKeyword(q, opts)
      return raws
        .map((r) => toNormalizedPart(r, this.provider.name))
        .filter((p): p is NormalizedPart => p !== null)
    } catch (err) {
      this.lastError = err instanceof PartsError ? `${err.code}: ${err.message}` : String(err)
      return []
    }
  }

  /**
   * 替代料。远端没这个能力时走本地兜底（同类目 + 参数区间 + 向量相似），
   * **而不是返回空数组让 LLM 以为「确实没有替代料」**。
   */
  async getAlternates(rawMpn: string): Promise<RawAlternate[]> {
    const mpn = normalizeMpn(rawMpn)
    if (this.provider.capabilities.alternates && this.provider.getAlternates) {
      try {
        return await this.provider.getAlternates(mpn)
      } catch (err) {
        this.lastError = err instanceof PartsError ? `${err.code}: ${err.message}` : String(err)
      }
    }
    return this.localAlternates(mpn)
  }

  private async localAlternates(mpn: string): Promise<RawAlternate[]> {
    const self = await this.getByMpn(mpn)
    if (!self || !this.byVector) return []
    const hits = await this.byVector([self.description, self.category].filter(Boolean).join(' '))
    return hits
      .filter((h) => h.part.mpn !== self.mpn && h.part.category === self.category)
      .slice(0, 5)
      .map((h) => ({
        mpn: h.part.mpn,
        kind: 'FUNCTIONAL' as const,
        confidence: Math.min(0.6, h.cosine),
        reason: `本地兜底：同类目 ${self.category}，语义相似 ${h.cosine.toFixed(2)}`,
      }))
  }

  /**
   * 参考设计。ezPLM 独有的能力，方案里没算到。
   *
   * 一颗芯片的官方参考电路，对「你的设计和参考设计差在哪」这类问题比参数表
   * 更直接。provider 没这个能力时返回空数组 —— 这里可以返回空，因为「没有
   * 参考设计」和「不支持参考设计」对调用方是同一件事：都没有可用的参考电路。
   * （替代料不一样：那里返回空会让 LLM 以为「确实没有替代料」，所以走本地兜底。）
   */
  async getReferenceDesigns(rawMpn: string): Promise<EzplmReferenceDesign[]> {
    const p = this.provider
    if (!(p instanceof EzplmPartsProvider)) return []
    const mpn = normalizeMpn(rawMpn)
    try {
      const raw = await p.getByMpn(mpn)
      const id = raw && typeof raw.id === 'string' ? raw.id : null
      if (!id) return []
      return await p.getReferenceDesigns(id)
    } catch (err) {
      this.lastError = err instanceof PartsError ? `${err.code}: ${err.message}` : String(err)
      return []
    }
  }

  /** 匹配单个组件，四层管线见 match/index.ts */
  matchComponent(component: ComponentLike): Promise<MatchResult> {
    const deps: MatchDeps = {
      byMpn: (m) => this.getByMpn(m),
      byPrefix: async (p) => {
        if (this.mirror) {
          const hits = await this.mirror.byPrefix(p)
          if (hits.length > 0) return hits
        }
        const direct = await this.getByMpn(p)
        return direct ? [direct] : []
      },
      byParametric: async (cat: PartCategory, value, pkg) =>
        this.mirror ? this.mirror.byParametric(cat, value, pkg) : [],
      ...(this.byVector ? { byVector: this.byVector } : {}),
    }
    return matchComponent(component, deps)
  }

  /** 批量匹配。顺序执行即可 —— 并发控制在 provider 的 batchGetByMpn 里。 */
  async matchComponents(components: ComponentLike[]): Promise<MatchResult[]> {
    const out: MatchResult[] = []
    for (const c of components) out.push(await this.matchComponent(c))
    return out
  }

  /** 与 llm.degraded / storage.degraded 同构 */
  async describe(): Promise<PartsHealth> {
    const h = await this.provider.health().catch(() => ({
      degraded: true,
      lastError: 'health 探测失败',
      latencyMs: 0,
    }))
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const p95 = sorted.length === 0 ? null : sorted[Math.floor(sorted.length * 0.95)] ?? null

    return {
      provider: this.provider.name,
      degraded: this.info.degraded || h.degraded,
      mirrorHit: this.mirror?.hitRate ?? null,
      lastError: this.lastError ?? h.lastError ?? this.info.reason,
      latencyP95Ms: p95,
      ...(this.info.missingSpec.length > 0 ? { missingSpec: this.info.missingSpec } : {}),
    }
  }
}
