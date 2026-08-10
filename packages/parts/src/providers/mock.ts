import type { ParametricQuery, RawAlternate, RawPart } from '../types'
import type { PartsCapabilities, PartsProvider } from './base'
import { normalizeMpn } from '../normalize/mpn'

/**
 * 内置常识参数。
 *
 * 迁自 apps/api/src/parts/parts.service.ts 的 BUILTIN，并按 §2.4 白名单补齐了
 * 结构化参数 —— 原来的 `supplyRange: '2.7~5.5 V'` 是给人看的，
 * PART_SPEC_VIOLATION 这类确定性规则需要能比较的数值。
 *
 * 只给常识参数，**绝不假装有真实库存和价格**：commercial 一律留空。
 */
const BUILTIN: RawPart[] = [
  {
    mpn: 'AD8605',
    manufacturer: 'Analog Devices',
    category: '运算放大器',
    description: '低噪声 CMOS 精密运放，轨到轨输入输出，单电源工作',
    package: 'SOIC-8',
    lifecycle: 'active',
    params: {
      vsMin: '2.7 V', vsMax: '5.5 V', vsAbsMax: '6 V',
      rrio: true, ibTyp: '1 pA', gbw: '10 MHz',
      slewRate: '5 V/us', voutSwingMv: '20 mV', isupply: '1.2 mA',
    },
  },
  {
    mpn: 'MCP4725',
    manufacturer: 'Microchip',
    category: 'DAC',
    description: '12 位 I2C 接口 DAC，带 EEPROM',
    package: 'SOT-23-6',
    lifecycle: 'active',
    params: {
      bits: 12, interface: 'I2C', i2cAddr: '0x60',
      vrefMin: '2.7 V', vrefMax: '5.5 V', sampleRate: '3.4 MHz',
      vddMin: '2.7 V', vddMax: '5.5 V',
    },
  },
  {
    mpn: 'TPS7A02',
    manufacturer: 'Texas Instruments',
    category: 'LDO 稳压器',
    description: '超低静态电流 LDO，200 mA 输出',
    package: 'SOT-23-5',
    lifecycle: 'active',
    params: {
      vinMin: '1.5 V', vinMax: '6 V', voutNom: '3.3 V', ioutMax: '200 mA',
      dropoutMv: '190 mV', coutMin: '1 uF', coutEsr: '0.1 ohm', pgThreshold: '90 %',
    },
  },
  {
    mpn: 'OPA192',
    manufacturer: 'Texas Instruments',
    category: '运算放大器',
    description: '精密轨到轨运放，宽供电范围',
    package: 'SOIC-8',
    lifecycle: 'active',
    params: {
      vsMin: '4.5 V', vsMax: '36 V', vsAbsMax: '40 V',
      rrio: true, ibTyp: '5 pA', gbw: '10 MHz',
      slewRate: '20 V/us', voutSwingMv: '15 mV', isupply: '1 mA',
    },
  },
  {
    // 故意留一颗参数不全的：DesignDigest 的 params-partial 分支要有东西可测
    mpn: 'LM358',
    manufacturer: 'Texas Instruments',
    category: '运算放大器',
    description: '通用双运放',
    package: 'SOIC-8',
    lifecycle: 'nrnd',
    params: { vsMin: '3 V', vsMax: '32 V', gbw: '1 MHz' },
  },
]

const ALTERNATES: Record<string, RawAlternate[]> = {
  AD8605: [
    { mpn: 'AD8606', kind: 'FUNCTIONAL', confidence: 0.9, reason: '同系列双通道版本' },
    { mpn: 'OPA192', kind: 'FUNCTIONAL', confidence: 0.6, reason: '同为精密 RRIO，供电范围更宽' },
  ],
  LM358: [{ mpn: 'AD8605', kind: 'UPGRADE', confidence: 0.7, reason: 'NRND，建议换精密 RRIO' }],
}

export class MockPartsProvider implements PartsProvider {
  readonly name = 'mock' as const
  readonly capabilities: PartsCapabilities = {
    exactLookup: true,
    keywordSearch: true,
    batchLookup: true,
    alternates: true,
    lifecycle: true,
    parametric: false,
  }

  private readonly byMpn = new Map(BUILTIN.map((p) => [normalizeMpn(String(p.mpn)), p]))

  async getByMpn(mpn: string): Promise<RawPart | null> {
    return this.byMpn.get(normalizeMpn(mpn)) ?? null
  }

  async batchGetByMpn(mpns: string[]): Promise<Map<string, RawPart>> {
    const out = new Map<string, RawPart>()
    for (const m of mpns) {
      const hit = this.byMpn.get(normalizeMpn(m))
      if (hit) out.set(normalizeMpn(m), hit)
    }
    return out
  }

  async searchByKeyword(q: string, opts?: { limit?: number }): Promise<RawPart[]> {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const hits = BUILTIN.filter((p) =>
      [p.mpn, p.manufacturer, p.category, p.description]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(needle)),
    )
    return hits.slice(0, opts?.limit ?? 20)
  }

  async searchParametric(_q: ParametricQuery): Promise<RawPart[]> {
    // 内置库只有 5 颗，参数化检索没有意义。capabilities.parametric=false，
    // 上游据此走本地兜底，不会调到这里。
    return []
  }

  async getAlternates(mpn: string): Promise<RawAlternate[]> {
    return ALTERNATES[normalizeMpn(mpn)] ?? []
  }

  async health() {
    return { degraded: false, lastError: null, latencyMs: 0 }
  }
}
