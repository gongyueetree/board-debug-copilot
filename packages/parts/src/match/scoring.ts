import type { MatchMethod, MatchStatus } from '../types'

/**
 * 每层的置信区间。命中即停，层内再按证据强度微调。
 *
 * 分层而不是给一个连续分数：不同层的失败模式完全不同，混成一个数字之后，
 * 「MPN 精确命中但制造商对不上」和「参数化猜出来的」会长得一样。
 */
export const CONFIDENCE_RANGE: Record<MatchMethod, [number, number]> = {
  EXACT: [0.95, 1.0],
  PREFIX: [0.75, 0.94],
  PARAMETRIC: [0.55, 0.8],
  VECTOR: [0.3, 0.6],
  MANUAL: [1.0, 1.0],
}

/**
 * 低于这个值一律 NEEDS_REVIEW，由人确认。
 *
 * 自动采纳低置信匹配是这类系统最典型的翻车方式：一个错误的 vsAbsMax
 * 会让 AI 得出一个看起来极其笃定的错误根因，而没人会去质疑它。
 */
export const AUTO_ACCEPT_THRESHOLD = 0.6

export function clampToRange(method: MatchMethod, score: number): number {
  const [lo, hi] = CONFIDENCE_RANGE[method]
  return Math.min(hi, Math.max(lo, score))
}

export function statusFor(confidence: number): MatchStatus {
  return confidence >= AUTO_ACCEPT_THRESHOLD ? 'MATCHED' : 'NEEDS_REVIEW'
}

export function isAutoAccepted(confidence: number): boolean {
  return confidence >= AUTO_ACCEPT_THRESHOLD
}

/**
 * L2 前缀匹配的分数：候选前缀越接近原串越可信。
 * 制造商也对得上再加一点 —— 型号前缀撞车在不同厂之间很常见。
 */
export function prefixScore(
  candidateLength: number,
  originalLength: number,
  manufacturerMatches: boolean,
): number {
  const ratio = originalLength === 0 ? 0 : candidateLength / originalLength
  return clampToRange('PREFIX', 0.75 + ratio * 0.14 + (manufacturerMatches ? 0.05 : 0))
}

/** L3 参数化：命中的维度越多越可信（值 / 封装 / 类目） */
export function parametricScore(dimensionsMatched: number, dimensionsTried: number): number {
  const ratio = dimensionsTried === 0 ? 0 : dimensionsMatched / dimensionsTried
  return clampToRange('PARAMETRIC', 0.55 + ratio * 0.25)
}

/** L4 向量：余弦相似度直接映射到区间，永不自动采纳 */
export function vectorScore(cosine: number): number {
  return clampToRange('VECTOR', cosine)
}
