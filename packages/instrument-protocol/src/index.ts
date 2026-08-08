/**
 * @app/instrument-protocol — Bridge 的 WS / REST 消息契约
 *
 * 与 apps/m2k-bridge 的 pydantic 模型一一对应，改动必须同步两侧。
 * 协议见 docs/01「Bridge 协议」，安全边界见 CLAUDE.md 硬性原则 #5/#6。
 */
import { z } from 'zod'

export const BRIDGE_DEFAULT_URL = 'http://127.0.0.1:3777'

export const ScenarioSchema = z.enum([
  'normal',
  'gain_error',
  'clipping',
  'noisy',
  'no_response',
])
export type Scenario = z.infer<typeof ScenarioSchema>

export const BridgeStatusSchema = z.object({
  connected: z.boolean(),
  device: z.string().nullable(),
  serial: z.string().nullable(),
  firmware: z.string().nullable(),
  mock: z.boolean(),
  scenario: ScenarioSchema.optional(),
})
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>

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
  wave: z.enum(['sine', 'square', 'triangle', 'sawtooth', 'dc']),
  freqHz: z.number().min(0).max(M2K_LIMITS.awgMaxFreqHz),
  amplitudeVpp: z.number().min(0).max(M2K_LIMITS.awgMaxVpp),
  offsetV: z.number().min(-M2K_LIMITS.awgMaxOffsetV).max(M2K_LIMITS.awgMaxOffsetV),
  /** 幅度 > 5Vpp 或偏置 != 0 时前端必须已二次确认 */
  confirm: z.boolean().optional(),
})
export type AwgConfig = z.infer<typeof AwgConfigSchema>

export const ScopeConfigSchema = z.object({
  timebaseSPerDiv: z.number().positive(),
  sampleRate: z.number().positive().max(M2K_LIMITS.scopeMaxSampleRate),
  trigger: z.object({
    source: z.enum(['CH1', 'CH2', 'EXT', 'NONE']),
    edge: z.enum(['rising', 'falling']),
    levelV: z.number(),
  }),
  channels: z.record(
    z.enum(['CH1', 'CH2']),
    z.object({
      voltsPerDiv: z.number().positive(),
      coupling: z.enum(['DC', 'AC']),
      probe: z.enum(['1x', '10x']).default('1x'),
    }),
  ),
})
export type ScopeConfig = z.infer<typeof ScopeConfigSchema>

export const ChannelMeasurementSchema = z.object({
  vpp: z.number(),
  vrms: z.number(),
  freqHz: z.number(),
  offsetV: z.number(),
  vmax: z.number(),
  vmin: z.number(),
  thdnPct: z.number().optional(),
})

export const MeasurementsFrameSchema = z.object({
  type: z.literal('measurements'),
  ch1: ChannelMeasurementSchema,
  ch2: ChannelMeasurementSchema,
  /** CH2/CH1 */
  gain: z.number(),
  gainDb: z.number(),
  /** 相对 CH1 的相位，反相放大器理想值 180 */
  phaseDeg: z.number(),
  /** 相对反相理想值 180 度的偏差，UI 显示这个（docs/05 §8.4） */
  phaseDeviationDeg: z.number(),
})
export type MeasurementsFrame = z.infer<typeof MeasurementsFrameSchema>

export const WaveformFrameSchema = z.object({
  type: z.literal('waveform'),
  ch1: z.array(z.number()),
  ch2: z.array(z.number()),
  meta: z.object({ fs: z.number(), ts: z.number(), sequence: z.number() }),
})
export type WaveformFrame = z.infer<typeof WaveformFrameSchema>

export const BridgeMessageSchema = z.discriminatedUnion('type', [
  WaveformFrameSchema,
  MeasurementsFrameSchema,
])
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>

/** docs/05 §9.4：安全层是确定性后处理，不由模型决定 */
export function requiresConfirm(awg: Pick<AwgConfig, 'amplitudeVpp' | 'offsetV'>): boolean {
  return awg.amplitudeVpp > 5 || awg.offsetV !== 0
}
