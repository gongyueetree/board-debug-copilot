/**
 * @app/contracts — 前后端共享的 Zod DTO / schema
 *
 * P1 落地全量 schema，规格见 docs/05-agent-design.md §7。
 * 这里先定义所有下游都要用的基础枚举与严重度映射，避免各包各写一份。
 */
import { z } from 'zod'

export const SeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL'])
export type Severity = z.infer<typeof SeveritySchema>

export const OriginSchema = z.enum([
  'RULE_ENGINE',
  'ERC',
  'DRC',
  'AI',
  'MEASUREMENT',
  'VISION',
])
export type Origin = z.infer<typeof OriginSchema>

export const AgentIntentSchema = z.enum([
  'design_review',
  'measure_guide',
  'waveform_analyze',
  'fault_diagnose',
  'photo_analyze',
  'report_generate',
  'general_chat',
])
export type AgentIntent = z.infer<typeof AgentIntentSchema>

export const ScenarioSchema = z.enum([
  'normal',
  'gain_error',
  'clipping',
  'noisy',
  'no_response',
])
export type Scenario = z.infer<typeof ScenarioSchema>

/** docs/05 §5.3：枚举 severity 与 UI pill 的唯一映射 */
export const SEVERITY_UI = {
  CRITICAL: { label: '高风险', tone: 'red' },
  WARNING: { label: '中风险', tone: 'orange' },
  INFO: { label: '低风险', tone: 'slate' },
} as const

/** VisualFinding.severity 直接存中文，'正常' 不对应任何 DiagnosisSeverity */
export const VISUAL_SEVERITIES = ['高风险', '中风险', '低风险', '正常'] as const
export type VisualSeverity = (typeof VISUAL_SEVERITIES)[number]

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  mockMode: z.boolean(),
  timestamp: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>
