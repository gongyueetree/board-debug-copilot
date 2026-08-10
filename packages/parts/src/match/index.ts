import type {
  ComponentLike,
  MatchResult,
  NormalizedPart,
  PartCategory,
} from '../types'
import { guessCategoryFromRef } from '../mapping/category-map'
import { normalizePackage, parseQuantity } from '../mapping/unit'
import { mpnPrefixCandidates, normalizeMpn } from '../normalize/mpn'
import {
  clampToRange,
  parametricScore,
  prefixScore,
  statusFor,
  vectorScore,
} from './scoring'

/** 匹配管线依赖的查询能力，由 PartsService 注入 */
export interface MatchDeps {
  byMpn(mpn: string): Promise<NormalizedPart | null>
  byPrefix(prefix: string): Promise<NormalizedPart[]>
  byParametric(
    category: PartCategory,
    value: number | null,
    packageCase?: string,
  ): Promise<NormalizedPart[]>
  byVector?(text: string): Promise<{ part: NormalizedPart; cosine: number }[]>
}

const unmatched = (ref: string, reason: string): MatchResult => ({
  componentRef: ref,
  method: 'EXACT',
  confidence: 0,
  status: 'UNMATCHED',
  part: null,
  reason,
})

/**
 * 四层匹配，命中即停。
 *
 * 顺序不能换：L1 是无损的，L2 会剥后缀（AD8605ARTZ 与 AD8605 封装不同），
 * L3 只看电气值（两颗 10k 电阻可能来自不同厂），L4 只看描述像不像。
 * 越往下越像「猜」，所以越往下 confidence 越低，L4 永不自动采纳。
 */
export async function matchComponent(
  component: ComponentLike,
  deps: MatchDeps,
): Promise<MatchResult> {
  const ref = component.ref

  // ── L1 MPN 精确 ─────────────────────────────────────────────
  if (component.partNumber) {
    const hit = await deps.byMpn(normalizeMpn(component.partNumber))
    if (hit) {
      const mfrOk =
        !component.manufacturer ||
        !hit.manufacturer ||
        hit.manufacturer.toLowerCase().includes(component.manufacturer.toLowerCase())
      // 制造商对不上时压到区间下沿：MPN 撞车虽少见但确实存在
      const confidence = clampToRange('EXACT', mfrOk ? 1.0 : 0.95)
      return {
        componentRef: ref,
        method: 'EXACT',
        confidence,
        status: statusFor(confidence),
        part: hit,
        reason: `MPN 精确命中 ${hit.mpn}` + (mfrOk ? '' : `（制造商不一致：BOM 写 ${component.manufacturer}）`),
      }
    }
  }

  // ── L2 制造商 + 型号前缀 ────────────────────────────────────
  if (component.partNumber) {
    const original = normalizeMpn(component.partNumber)
    for (const cand of mpnPrefixCandidates(component.partNumber)) {
      if (cand === original) continue // L1 已经试过
      const hits = await deps.byPrefix(cand)
      if (hits.length === 0) continue

      const mfrHit = component.manufacturer
        ? hits.find((h) =>
            h.manufacturer?.toLowerCase().includes(component.manufacturer!.toLowerCase()),
          )
        : undefined
      const chosen = mfrHit ?? hits[0]!
      const confidence = prefixScore(cand.length, original.length, Boolean(mfrHit))
      return {
        componentRef: ref,
        method: 'PREFIX',
        confidence,
        status: statusFor(confidence),
        part: chosen,
        reason: `型号前缀 ${cand} 命中 ${chosen.mpn}（原串 ${component.partNumber}）`,
      }
    }
  }

  // ── L3 参数化（阻容感主力路径）─────────────────────────────
  const category = guessCategoryFromRef(ref)
  const isPassive = category === 'RESISTOR' || category === 'CAPACITOR' || category === 'INDUCTOR'
  if (isPassive && component.value) {
    const q = parseQuantity(component.value)
    const pkg = normalizePackage(component.footprint)
    const hits = await deps.byParametric(category, q?.value ?? null, pkg)
    if (hits.length > 0) {
      let tried = 1 // 类目总是算一维
      let matched = 1
      if (q) {
        tried++
        matched++
      }
      if (pkg) {
        tried++
        if (hits[0]!.packageCase === pkg) matched++
      }
      const confidence = parametricScore(matched, tried)
      return {
        componentRef: ref,
        method: 'PARAMETRIC',
        confidence,
        status: statusFor(confidence),
        part: hits[0]!,
        reason:
          `参数化命中：${category}` +
          (q ? ` 值=${component.value}` : '') +
          (pkg ? ` 封装=${pkg}` : ''),
      }
    }
  }

  // ── L4 向量语义（兜底，永不自动采纳）───────────────────────
  if (deps.byVector) {
    const text = [component.partNumber, component.value, component.footprint]
      .filter(Boolean)
      .join(' ')
    if (text.trim()) {
      const hits = await deps.byVector(text)
      const best = hits[0]
      if (best) {
        const confidence = vectorScore(best.cosine)
        return {
          componentRef: ref,
          method: 'VECTOR',
          confidence,
          // vectorScore 上限 0.6，恰好等于阈值；这里显式写死 NEEDS_REVIEW，
          // 免得将来有人调宽区间就把兜底层变成自动采纳
          status: 'NEEDS_REVIEW',
          part: best.part,
          reason: `语义相似 ${best.cosine.toFixed(2)} → ${best.part.mpn}（仅供参考，需人工确认）`,
        }
      }
    }
  }

  return unmatched(ref, component.partNumber ? `未在器件库中找到 ${component.partNumber}` : '组件无型号信息')
}
