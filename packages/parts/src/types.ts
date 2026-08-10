/**
 * 内部器件模型。
 *
 * 整个 packages/parts 只做一件事：把一个我们不控制的外部器件库，收敛成
 * NormalizedPart。远端字段长什么样、分页怎么翻、鉴权怎么做，只影响
 * providers/remote.ts 与 mapping/ 两处；其余代码永远只见这里的类型。
 */

/** 内部类目枚举。与 packages/db 的 PartCategory 一一对应，改一边必须改另一边。 */
export const PART_CATEGORIES = [
  'OPAMP', 'LDO', 'DCDC', 'ADC', 'DAC', 'MCU', 'FPGA', 'MEMORY',
  'RESISTOR', 'CAPACITOR', 'INDUCTOR', 'DIODE', 'LED', 'MOSFET', 'BJT',
  'CRYSTAL', 'CONNECTOR', 'SENSOR', 'TRANSCEIVER', 'OTHER',
] as const
export type PartCategory = (typeof PART_CATEGORIES)[number]

export const PART_LIFECYCLES = ['ACTIVE', 'NRND', 'EOL', 'OBSOLETE', 'UNKNOWN'] as const
export type PartLifecycle = (typeof PART_LIFECYCLES)[number]

export const MATCH_METHODS = ['EXACT', 'PREFIX', 'PARAMETRIC', 'VECTOR', 'MANUAL'] as const
export type MatchMethod = (typeof MATCH_METHODS)[number]

export const MATCH_STATUSES = ['UNMATCHED', 'MATCHED', 'NEEDS_REVIEW', 'REJECTED'] as const
export type MatchStatus = (typeof MATCH_STATUSES)[number]

export interface ParamValue {
  value: number | string | boolean
  unit?: string
  /** 原始串，排查映射错误时唯一的线索 */
  raw?: string
}

/**
 * 参数抽取的自述。
 *
 * 抽不到不许静默：complete=false + missing 列表，让 DesignDigest 把这颗器件
 * 降级成 params-unknown。一个诚实的「不知道」比一个猜出来的 vsAbsMax
 * 安全一百倍 —— 后者会让 AI 得出看起来极其笃定的错误根因。
 */
export interface ParamMeta {
  complete: boolean
  missing: string[]
  /** 哪个解析器产出的，版本号方便回溯 */
  parser: string
}

export type ParamBag = Record<string, ParamValue> & { __meta?: ParamMeta }

export interface NormalizedPart {
  /** 归一化后（大写、去 - _ 空格），主键 */
  mpn: string
  /** 原始串，展示用 */
  rawMpn: string
  manufacturer?: string
  category: PartCategory
  description?: string
  /** 归一化后：SOIC-8 / 0402 / SOT-23-6 */
  packageCase?: string
  datasheetUrl?: string
  lifecycle: PartLifecycle
  rohs?: boolean
  /** 调试真正要用的电气边界 */
  params: ParamBag
  /**
   * 商务信息与 params 严格分离。
   *
   * 价格与库存对根因推断零贡献，却会挤占 docs/05 §4.3 定死的 token 预算
   * （design_review 6k / waveform_analyze 5k）。分开放是为了在 prompt 侧
   * 一刀切掉：它们只在 BOM 风险与报告场景出现。
   */
  commercial?: { priceRef?: number; stock?: number; leadTimeDays?: number }
  source: { provider: string; id?: string; fetchedAt: string }
}

/** provider 返回的原始记录，形状由远端决定，只有 mapping/ 认识它 */
export type RawPart = Record<string, unknown>

export interface RawAlternate {
  mpn: string
  kind: 'PIN2PIN' | 'FUNCTIONAL' | 'UPGRADE'
  confidence: number
  reason?: string
}

export interface ParametricQuery {
  category: PartCategory
  params?: Record<string, { min?: number; max?: number; eq?: number | string }>
  packageCase?: string
  limit?: number
}

/** 待匹配的组件（从 Component 表来，但不依赖 @app/db 的类型） */
export interface ComponentLike {
  id?: string
  ref: string
  value?: string | null
  partNumber?: string | null
  manufacturer?: string | null
  footprint?: string | null
}

export interface MatchResult {
  componentRef: string
  method: MatchMethod
  confidence: number
  status: MatchStatus
  /** 命中的器件；未命中为 null */
  part: NormalizedPart | null
  /** 人能看懂的判定依据，写进 PartMatch.summaryJson */
  reason: string
}

export interface PartsHealth {
  provider: string
  degraded: boolean
  /** 镜像命中率，0~1；无请求时为 null */
  mirrorHit: number | null
  lastError: string | null
  latencyP95Ms: number | null
  /** 参考文件缺哪几项 —— 缺项时 remote provider 不可用 */
  missingSpec?: string[]
}
