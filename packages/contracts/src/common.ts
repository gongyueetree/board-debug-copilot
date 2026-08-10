import { z } from 'zod'

export const SeveritySchema = z.enum(['INFO', 'WARNING', 'CRITICAL'])
export type Severity = z.infer<typeof SeveritySchema>

export const OriginSchema = z.enum(['RULE_ENGINE', 'ERC', 'DRC', 'AI', 'MEASUREMENT', 'VISION'])
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

export const ScenarioSchema = z.enum(['normal', 'gain_error', 'clipping', 'noisy', 'no_response'])
export type Scenario = z.infer<typeof ScenarioSchema>

export const StepStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
])
export type StepStatus = z.infer<typeof StepStatusSchema>

export const ProjectStatusSchema = z.enum(['CREATED', 'UPLOADED', 'PARSING', 'READY', 'ERROR'])

/** docs/05 §5.3：枚举 severity 与 UI pill 的唯一映射 */
export const SEVERITY_UI = {
  CRITICAL: { label: '高风险', tone: 'red' },
  WARNING: { label: '中风险', tone: 'orange' },
  INFO: { label: '低风险', tone: 'slate' },
} as const

export const VisualSeveritySchema = z.enum(['高风险', '中风险', '低风险', '正常'])
export type VisualSeverity = z.infer<typeof VisualSeveritySchema>

export const HealthResponseSchema = z.object({
  /** unhealthy：进程起来了但配置不该上生产（目前只有 mock 存储会触发） */
  status: z.enum(['ok', 'unhealthy']),
  service: z.string(),
  version: z.string(),
  mockMode: z.boolean(),
  timestamp: z.string(),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>
