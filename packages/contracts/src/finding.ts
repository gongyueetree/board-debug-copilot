import { z } from 'zod'
import { OriginSchema, SeveritySchema } from './common'

/** docs/05 §5.2 受控 code 词表 —— 防泛泛而谈的第一道闸 */
export const SCHEMATIC_CODES = [
  'POWER_NET_MISSING',
  'GND_NET_MISSING',
  'SINGLE_PIN_NET',
  'FLOATING_INPUT',
  'OPAMP_FEEDBACK_SUSPECT',
  'OPEN_DRAIN_NO_PULLUP',
  'I2C_PULLUP_MISSING',
  'DECOUPLING_INSUFFICIENT',
  'LDO_CAP_MISSING',
  'RESET_PIN_FLOATING',
  'CONNECTOR_UNPROTECTED',
] as const

export const DESIGN_INFERENCE_CODES = [
  'OUTPUT_SWING_CLIPPING_RISK',
  'INPUT_BIAS_CURRENT_ERROR',
  'GND_REFERENCE_DISCONTINUITY',
  'DECOUPLING_PLACEMENT_POOR',
  'SUPPLY_HEADROOM_INSUFFICIENT',
  'LOAD_DRIVE_INSUFFICIENT',
] as const

export const MEASUREMENT_CODES = [
  'OUTPUT_CLIPPING',
  'OFFSET_ABNORMAL',
  'FREQ_MISMATCH',
  'GAIN_MISMATCH',
  'PHASE_MISMATCH',
  'NOISE_EXCESSIVE',
  'RINGING_OVERSHOOT',
  'INPUT_FLOATING',
  'NO_RESPONSE',
  'LOGIC_LEVEL_INVALID',
  'THDN_HIGH',
] as const

export const VISION_CODES = [
  'SOLDER_BRIDGE',
  'MISSING_PART',
  'POLARITY',
  'ORIENTATION',
  'JOINT_QUALITY',
] as const

export const FINDING_CODES = [
  ...SCHEMATIC_CODES,
  ...DESIGN_INFERENCE_CODES,
  ...MEASUREMENT_CODES,
  ...VISION_CODES,
] as const

export const FindingCodeSchema = z.enum(FINDING_CODES)
export type FindingCode = z.infer<typeof FindingCodeSchema>

/** 统一发现体，字段与 Prisma RuleViolation 一一对应（docs/05 §7.1） */
export const FindingSchema = z.object({
  id: z.string().optional(),
  code: FindingCodeSchema,
  origin: OriginSchema,
  severity: SeveritySchema,
  title: z.string().min(2).max(40),
  description: z.string().min(10).max(600),
  /** 落库时 join('\n') → RuleViolation.evidence */
  evidence: z.array(z.string()).min(1).max(8),
  risk: z.string().max(300),
  suggestion: z.string().max(400),
  recommendedTest: z.string().max(300).nullable().optional(),
  componentRef: z.string().max(16).nullable().optional(),
  netName: z.string().max(32).nullable().optional(),
  resolved: z.boolean().default(false),
  confidence: z.number().min(0).max(1).optional(),
})
export type Finding = z.infer<typeof FindingSchema>
