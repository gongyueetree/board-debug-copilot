import { z } from 'zod'

/** ADALM2000 硬件上限，越界一律拒绝（docs/05 §9.4） */
export const M2K_LIMITS = {
  awgMaxVpp: 10,
  awgMaxOffsetV: 5,
  awgMaxFreqHz: 30_000_000,
  scopeMaxInputV: 25,
  scopeMaxSampleRate: 100_000_000,
} as const

export const AwgConfigSchema = z.object({
  channel: z.enum(['W1', 'W2']),
  target: z.string().optional(),
  wave: z.enum(['sine', 'square', 'triangle', 'sawtooth', 'dc']),
  freqHz: z.number().min(0).max(M2K_LIMITS.awgMaxFreqHz),
  amplitudeVpp: z.number().min(0).max(M2K_LIMITS.awgMaxVpp),
  offsetV: z.number().min(-M2K_LIMITS.awgMaxOffsetV).max(M2K_LIMITS.awgMaxOffsetV),
  requiresConfirm: z.boolean().optional(),
})
export type AwgConfig = z.infer<typeof AwgConfigSchema>

export const ScopeChannelSchema = z.object({
  voltsPerDiv: z.number().positive(),
  coupling: z.enum(['DC', 'AC']),
  probe: z.enum(['1x', '10x']).default('1x'),
  label: z.string().optional(),
})

export const ScopeConfigSchema = z.object({
  timebaseSPerDiv: z.number().positive(),
  sampleRate: z.number().positive().max(M2K_LIMITS.scopeMaxSampleRate),
  trigger: z.object({
    source: z.enum(['CH1', 'CH2', 'EXT', 'NONE']),
    edge: z.enum(['rising', 'falling']),
    levelV: z.number(),
  }),
  channels: z.object({ CH1: ScopeChannelSchema, CH2: ScopeChannelSchema }),
})
export type ScopeConfig = z.infer<typeof ScopeConfigSchema>

export const WiringSchema = z.object({
  from: z.string(),
  to: z.string(),
  note: z.string().optional(),
})

/** ↔ DebugStep.setupJson / Capture.hardwareSetupJson（docs/05 §7.4） */
export const InstrumentPresetSchema = z.object({
  mode: z.enum(['SCOPE', 'DMM', 'AWG_SCOPE', 'FFT', 'LOGIC']),
  awg: z.union([AwgConfigSchema, z.array(AwgConfigSchema)]).optional(),
  scope: ScopeConfigSchema.optional(),
  wiring: z.array(WiringSchema).min(1),
  range: z.string().optional(),
  trigger: z.string().optional(),
  /** 由安全层写入，模型无权置 false */
  requiresConfirm: z.boolean(),
  safetyNotes: z.array(z.string()),
})
export type InstrumentPreset = z.infer<typeof InstrumentPresetSchema>

/** docs/05 §9.4：确定性后处理，幅度 > 5Vpp 或偏置 != 0 必须二次确认 */
export function requiresConfirm(awg: Pick<AwgConfig, 'amplitudeVpp' | 'offsetV'>): boolean {
  return awg.amplitudeVpp > 5 || awg.offsetV !== 0
}

export const ChannelMeasurementSchema = z.object({
  vpp: z.number(),
  vrms: z.number(),
  freqHz: z.number(),
  offsetV: z.number(),
  vmax: z.number(),
  vmin: z.number(),
  thdnPct: z.number().optional(),
})

export const MeasurementsSchema = z.object({
  ch1: ChannelMeasurementSchema,
  ch2: ChannelMeasurementSchema,
  gain: z.number(),
  gainDb: z.number(),
  /** 相对 CH1，反相放大器理想值 180 */
  phaseDeg: z.number(),
  /** 相对反相理想值 180 度的偏差，UI 显示这个（docs/05 §8.4） */
  phaseDeviationDeg: z.number(),
  note: z.string().optional(),
})
export type Measurements = z.infer<typeof MeasurementsSchema>
