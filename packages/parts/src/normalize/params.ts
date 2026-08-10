import type { ParamBag, ParamValue, PartCategory } from '../types'
import { parseQuantity } from '../mapping/unit'

/**
 * 按类目抽取电气边界参数。
 *
 * 这张白名单决定了 AI 的上限：docs/05 §4.2 里那一行
 * `U1 AD8605 SOIC-8 opamp RRIO Vs=2.7~5.5V(absmax 6V) ...` 就是从这里来的，
 * 而文档原话是「这一段对输出质量的贡献大于其它所有段落之和」。
 *
 * 抽不到不许静默：写进 __meta.missing，让 DesignDigest 把该器件降级成
 * params-unknown。
 */
export const PARAM_WHITELIST: Record<PartCategory, string[]> = {
  OPAMP: ['vsMin', 'vsMax', 'vsAbsMax', 'rrio', 'ibTyp', 'gbw', 'slewRate', 'voutSwingMv', 'isupply'],
  LDO: ['vinMin', 'vinMax', 'voutNom', 'ioutMax', 'dropoutMv', 'coutMin', 'coutEsr', 'pgThreshold'],
  DCDC: ['vinMin', 'vinMax', 'voutNom', 'ioutMax', 'dropoutMv', 'coutMin', 'coutEsr', 'pgThreshold'],
  ADC: ['bits', 'interface', 'i2cAddr', 'vrefMin', 'vrefMax', 'sampleRate', 'vddMin', 'vddMax'],
  DAC: ['bits', 'interface', 'i2cAddr', 'vrefMin', 'vrefMax', 'sampleRate', 'vddMin', 'vddMax'],
  MCU: ['coreV', 'ioV', 'ioTolerant', 'resetActive', 'bootPins', 'swdPins'],
  FPGA: ['coreV', 'ioV', 'ioTolerant', 'resetActive', 'bootPins', 'swdPins'],
  RESISTOR: ['resistance', 'tolerance', 'powerW', 'tempco'],
  CAPACITOR: ['capacitance', 'voltageRating', 'dielectric', 'tolerance'],
  INDUCTOR: ['inductance', 'isat', 'dcr'],
  DIODE: ['vf', 'ifMax', 'vrrm'],
  LED: ['vf', 'ifMax', 'vrrm'],
  MOSFET: ['vgsTh', 'rdsOn', 'vdsMax', 'idMax'],
  BJT: ['vgsTh', 'rdsOn', 'vdsMax', 'idMax'],
  CONNECTOR: ['pins', 'pitch', 'currentRating'],
  MEMORY: [],
  CRYSTAL: [],
  SENSOR: [],
  TRANSCEIVER: [],
  OTHER: [],
}

/** 参数名的常见别名 —— 远端字段名千奇百怪，映射表在 mapping/field-map.ts */
const ALIASES: Record<string, string> = {
  supplyvoltagemin: 'vsMin', supplyvoltagemax: 'vsMax',
  supplyrange: 'vsRange', absmaxsupply: 'vsAbsMax', absolutemaximumsupply: 'vsAbsMax',
  gainbandwidth: 'gbw', gainbandwidthproduct: 'gbw',
  inputbiascurrent: 'ibTyp', slewrate: 'slewRate',
  outputcurrent: 'ioutMax', iout: 'ioutMax', dropout: 'dropoutMv',
  resolution: 'bits', capacitance: 'capacitance', resistance: 'resistance',
  voltagerating: 'voltageRating', powerrating: 'powerW',
}

const canon = (k: string) => ALIASES[k.toLowerCase().replace(/[\s_-]/g, '')] ?? k

function toParamValue(v: unknown): ParamValue | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return { value: v }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : null
  if (typeof v !== 'string') return null

  const q = parseQuantity(v)
  if (q) return { value: q.value, unit: q.unit ?? undefined, raw: v }
  return { value: v, raw: v }
}

/**
 * 从任意来源的键值对里，按类目白名单抽出参数。
 *
 * `parser` 带版本号：解析规则改了之后，靠它能分辨哪些镜像数据需要重抽。
 */
export function extractParams(
  category: PartCategory,
  source: Record<string, unknown>,
  parser = 'generic@v1',
): ParamBag {
  const want = PARAM_WHITELIST[category] ?? []
  const out: ParamBag = {}

  const normalized: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) normalized[canon(k)] = v

  for (const key of want) {
    const pv = toParamValue(normalized[key])
    if (pv) out[key] = pv
  }

  // vsRange 这类区间串（"2.7~5.5 V"）拆成 min/max
  const range = normalized.vsRange
  if (typeof range === 'string' && (!out.vsMin || !out.vsMax)) {
    const m = /([\d.]+)\s*[~\-–]\s*([\d.]+)/.exec(range)
    if (m) {
      if (!out.vsMin) out.vsMin = { value: Number(m[1]), unit: 'V', raw: range }
      if (!out.vsMax) out.vsMax = { value: Number(m[2]), unit: 'V', raw: range }
    }
  }

  const missing = want.filter((k) => !(k in out))
  out.__meta = { complete: want.length > 0 && missing.length === 0, missing, parser }
  return out
}

/** 参数完整率统计用：某个 bag 抽到了几项 / 应抽几项 */
export function paramCompleteness(category: PartCategory, bag: ParamBag): {
  got: number
  want: number
} {
  const want = (PARAM_WHITELIST[category] ?? []).length
  const got = want - (bag.__meta?.missing.length ?? want)
  return { got, want }
}
