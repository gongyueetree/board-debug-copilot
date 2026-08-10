/**
 * 单位归一。
 *
 * BOM 里的值是人手写的：10k / 10K / 10kΩ / 10 kohm / 10000 全是同一个电阻。
 * 不归一化，参数化匹配（L3）就永远命中不了 —— 而阻容感占一块板 BOM 的大头。
 */

const SI: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9,
}

/** 单位后缀去掉之后剩下的东西，用于识别量纲 */
const UNIT_ALIASES: Record<string, string> = {
  ohm: 'Ω', ohms: 'Ω', r: 'Ω', 'Ω': 'Ω',
  f: 'F', farad: 'F',
  h: 'H', henry: 'H',
  v: 'V', volt: 'V', volts: 'V',
  a: 'A', amp: 'A', amps: 'A',
  w: 'W', watt: 'W',
  hz: 'Hz',
}

export interface ParsedQuantity {
  value: number
  unit: string | null
  raw: string
}

/**
 * 把 "10k" / "4.7uF" / "0.1 µF" / "100R" / "2k2" 解析成数值 + 单位。
 *
 * 支持 R/K/M 做小数点的欧洲写法（2k2 = 2200）—— KiCad 库里很常见。
 * 解析不了返回 null，**不要瞎猜**：猜错的电容值会让 L3 匹配到一颗完全
 * 不同的器件，而下游看不出来。
 */
export function parseQuantity(input: string): ParsedQuantity | null {
  const raw = input.trim()
  if (!raw) return null

  // 2k2 / 4R7 / 1M5：字母当小数点
  const infix = /^(\d+)([pnuµμmkKMG]|R|r)(\d+)$/.exec(raw)
  if (infix) {
    const [, a, sym, b] = infix as unknown as [string, string, string, string]
    const mult = sym === 'R' || sym === 'r' ? 1 : (SI[sym] ?? 1)
    return { value: Number(`${a}.${b}`) * mult, unit: null, raw }
  }

  const m = /^([+-]?\d*\.?\d+)\s*([pnuµμmkKMG])?\s*([a-zA-ZΩ]*)$/.exec(raw)
  if (!m) return null
  const [, numStr, prefix, unitStr] = m as unknown as [string, string, string?, string?]
  const num = Number(numStr)
  if (!Number.isFinite(num)) return null

  let mult = prefix ? (SI[prefix] ?? 1) : 1
  let unit: string | null = null

  const tail = (unitStr ?? '').toLowerCase()
  if (tail) {
    unit = UNIT_ALIASES[tail] ?? null
    // "100R" 里 R 是单位不是前缀；"10Meg" 之类先不管
    if (unit === null && tail === 'meg') mult = 1e6
  } else if (prefix === 'R' || prefix === 'r') {
    unit = 'Ω'
    mult = 1
  }

  return { value: num * mult, unit, raw }
}

/** 封装归一：0402 / 1005Metric / R_0603_1608Metric → 0402 / 0603 */
export function normalizePackage(input?: string | null): string | undefined {
  if (!input) return undefined
  const s = input.trim()
  if (!s) return undefined

  // KiCad 封装名形如 Resistor_SMD:R_0603_1608Metric
  const imperial = /(?:^|[_:])([0-9]{4})(?:_|$)/.exec(s.replace(/^[^:]*:/, ''))
  if (imperial?.[1]) return imperial[1]

  // 尾部的引脚数不能丢：SOT-23-5 与 SOT-23-6 是两种封装，
  // collapse 成 SOT-23 会让 L3 参数化匹配挑错器件。
  const known = /(SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|LQFP|TQFP|QFP|BGA|SOT|TO)[-_]?(\d+(?:[-_]\d+)*)/i.exec(s)
  if (known) return `${known[1]!.toUpperCase()}-${known[2]!.replace(/_/g, '-')}`

  return s
}
