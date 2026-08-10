import type {
  ParametricQuery,
  PartsHealth,
  RawAlternate,
  RawPart,
} from '../types'

export class PartsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_CONFIGURED'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED'
      | 'TIMEOUT'
      | 'UPSTREAM'
      | 'BAD_RESPONSE',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'PartsError'
  }
}

/**
 * provider 声明自己能做什么。
 *
 * 这不是装饰：上游据它决定要不要降级到本地策略。远端没有 alternates 时，
 * findAlternates 走「同类目 + 参数区间 + 向量相似」的本地兜底，
 * 而不是返回空数组让 LLM 自己编。
 */
export interface PartsCapabilities {
  exactLookup: boolean
  keywordSearch: boolean
  batchLookup: boolean
  alternates: boolean
  lifecycle: boolean
  parametric: boolean
}

export interface PartsProvider {
  readonly name: 'mock' | 'remote'
  readonly capabilities: PartsCapabilities

  getByMpn(mpn: string): Promise<RawPart | null>
  /** 内部分片 + 并发上限；调用方给多少个就传多少个 */
  batchGetByMpn(mpns: string[]): Promise<Map<string, RawPart>>
  searchByKeyword(q: string, opts?: { category?: string; limit?: number }): Promise<RawPart[]>
  searchParametric?(q: ParametricQuery): Promise<RawPart[]>
  getAlternates?(mpn: string): Promise<RawAlternate[]>
  health(): Promise<Pick<PartsHealth, 'degraded' | 'lastError'> & { latencyMs: number }>
}
