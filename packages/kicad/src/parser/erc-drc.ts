/**
 * kicad-cli 的 ERC/DRC 报告解析。
 *
 * `--format json` 输出结构稳定；旧版本只有文本，所以两种都要能吃。
 * 归一化成受控 code，让设计审查页的 ERC/DRC 计数与规则引擎结果同构。
 */
import type { Finding, Severity } from '@app/contracts'

interface KicadViolation {
  type?: string
  description?: string
  severity?: string
  items?: { description?: string; uuid?: string }[]
}

/** KiCad 的 violation type → 受控 code。认不出的归到最接近的通用项。 */
export function normalizeCode(type: string): Finding['code'] {
  const t = type.toLowerCase()
  if (/pin_not_connected|unconnected/.test(t)) return 'FLOATING_INPUT'
  if (/pin_not_driven|no_driver/.test(t)) return 'POWER_NET_MISSING'
  if (/single_pin|net_not_connected/.test(t)) return 'SINGLE_PIN_NET'
  if (/power_pin/.test(t)) return 'POWER_NET_MISSING'
  if (/clearance|track_dangling|shorting/.test(t)) return 'GND_REFERENCE_DISCONTINUITY'
  if (/hole|drill|annular/.test(t)) return 'CONNECTOR_UNPROTECTED'
  if (/library|footprint|symbol/.test(t)) return 'SINGLE_PIN_NET'
  return 'SINGLE_PIN_NET'
}

export function normalizeSeverity(s: string | undefined): Severity {
  const v = (s ?? '').toLowerCase()
  if (v === 'error') return 'CRITICAL'
  if (v === 'warning') return 'WARNING'
  return 'INFO'
}

/** 从描述里抠位号与网络名，供 grounding 与 UI 定位使用 */
export function extractRefs(text: string): { componentRef?: string; netName?: string } {
  const ref = /\b([A-Z]{1,3}\d{1,4})\b/.exec(text)?.[1]
  const net = /net\s+"?([A-Za-z0-9_+\-.]+)"?/i.exec(text)?.[1]
  return { componentRef: ref, netName: net }
}

function toFinding(v: KicadViolation, origin: 'ERC' | 'DRC'): Finding | null {
  const type = v.type ?? ''
  const desc = v.description ?? type
  if (!desc) return null

  const items = (v.items ?? []).map((i) => i.description ?? '').filter(Boolean)
  const joined = [desc, ...items].join(' ')
  const { componentRef, netName } = extractRefs(joined)

  return {
    code: normalizeCode(type),
    origin,
    severity: normalizeSeverity(v.severity),
    title: desc.slice(0, 40),
    description: desc.slice(0, 600),
    // evidence 必须含具体内容，否则 grounding 层会丢弃它
    evidence: items.length > 0 ? items.slice(0, 6) : [`${origin} ${type}: ${desc}`.slice(0, 200)],
    risk: origin === 'ERC' ? '原理图连接错误可能导致电路不工作。' : 'PCB 违规可能导致制造或可靠性问题。',
    suggestion: `在 KiCad 中定位该 ${origin} 项并修正。`,
    componentRef: componentRef ?? null,
    netName: netName ?? null,
    resolved: false,
  }
}

export function parseErcDrcJson(raw: string, origin: 'ERC' | 'DRC'): Finding[] {
  try {
    const doc = JSON.parse(raw) as { violations?: KicadViolation[]; sheets?: { violations?: KicadViolation[] }[] }
    const violations = [
      ...(doc.violations ?? []),
      ...(doc.sheets ?? []).flatMap((s) => s.violations ?? []),
    ]
    return violations.map((v) => toFinding(v, origin)).filter((f): f is Finding => f !== null)
  } catch {
    return []
  }
}

/** 旧版 kicad-cli 的文本报告 */
export function parseErcDrcText(raw: string, origin: 'ERC' | 'DRC'): Finding[] {
  const out: Finding[] = []
  // 形如: [pin_not_connected]: Pin not connected  ... Severity: warning
  const re = /\[([a-z_]+)\]:\s*(.+?)(?:\n\s*(?:;|Severity:)\s*(\w+))?(?=\n\[|\n\n|$)/gis
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const f = toFinding({ type: m[1], description: m[2]?.trim(), severity: m[3] }, origin)
    if (f) out.push(f)
  }
  return out
}

export function parseErcDrc(raw: string, origin: 'ERC' | 'DRC'): Finding[] {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    const json = parseErcDrcJson(trimmed, origin)
    if (json.length > 0) return json
  }
  return parseErcDrcText(trimmed, origin)
}
