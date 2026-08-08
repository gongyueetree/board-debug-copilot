/**
 * L6 守卫管线 —— docs/05 §9
 *
 * parse → schema → grounding → safety → dedupe → fallback
 * 任一环节彻底失败都不能让页面空白：规则引擎结果照常展示。
 */
import type { Finding } from '@app/contracts'
import { z } from 'zod'

export interface GroundingContext {
  componentRefs: Set<string>
  netNames: Set<string>
}

export interface GuardStats {
  unknownRef: number
  unknownNet: number
  vagueEvidence: number
  unknownCode: number
  duplicate: number
}

export const emptyStats = (): GuardStats => ({
  unknownRef: 0,
  unknownNet: 0,
  vagueEvidence: 0,
  unknownCode: 0,
  duplicate: 0,
})

/** ① 从模型输出里抠出 JSON：去围栏、找首个平衡的花括号块 */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = (fenced?.[1] ?? raw).trim()

  const start = text.search(/[[{]/)
  if (start === -1) throw new Error('输出中没有找到 JSON')

  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') inStr = !inStr
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  throw new Error('JSON 括号不平衡（输出可能被截断）')
}

/** ② schema 校验；失败时把 zod issue 压成可回灌给模型的修复提示 */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; issues: string } {
  const r = schema.safeParse(data)
  if (r.success) return { ok: true, value: r.data }
  return {
    ok: false,
    issues: r.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  }
}

const HAS_NUMBER_OR_REF = /\d|[A-Z]{1,3}\d+/

/**
 * ③ 引用校验（反幻觉）—— 本设计最关键的一环。
 * 丢弃是静默的（不回灌重试，避免延迟翻倍），但必须计数。
 */
export function ground(findings: Finding[], ctx: GroundingContext, stats: GuardStats): Finding[] {
  return findings.filter((f) => {
    if (f.componentRef && !ctx.componentRefs.has(f.componentRef)) {
      stats.unknownRef++
      return false
    }
    if (f.netName && !ctx.netNames.has(f.netName)) {
      stats.unknownNet++
      return false
    }
    // evidence 至少一条要含具体数值或位号，否则就是"可能存在""建议检查一下"这类填充
    if (!f.evidence.some((e) => HAS_NUMBER_OR_REF.test(e))) {
      stats.vagueEvidence++
      return false
    }
    return true
  })
}

/**
 * ⑤ 与规则引擎结果合并去重。
 * 保留优先级 RULE_ENGINE > ERC/DRC > MEASUREMENT > VISION > AI：
 * 权威来源不被 LLM 覆盖，但 LLM 的解释并入补充说明，不丢失价值。
 */
const ORIGIN_RANK: Record<Finding['origin'], number> = {
  RULE_ENGINE: 0,
  ERC: 1,
  DRC: 1,
  MEASUREMENT: 2,
  VISION: 3,
  AI: 4,
}

export function dedupe(all: Finding[], stats: GuardStats): Finding[] {
  const byKey = new Map<string, Finding>()
  for (const f of [...all].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])) {
    const key = `${f.code}|${f.componentRef ?? ''}|${f.netName ?? ''}`
    const kept = byKey.get(key)
    if (!kept) {
      byKey.set(key, f)
      continue
    }
    stats.duplicate++
    if (f.origin === 'AI' && !kept.description.includes(f.description)) {
      kept.description = `${kept.description}\n\nAI 补充：${f.description}`
      if (f.evidence.length > 0) kept.evidence = [...new Set([...kept.evidence, ...f.evidence])]
    }
  }
  return [...byKey.values()]
}

export const droppedRate = (stats: GuardStats, total: number): number => {
  if (total === 0) return 0
  const dropped = stats.unknownRef + stats.unknownNet + stats.vagueEvidence + stats.unknownCode
  return dropped / total
}
