import { z } from 'zod'
import {
  ProjectStatusSchema,
  ScenarioSchema,
  SeveritySchema,
  StepStatusSchema,
  VisualSeveritySchema,
} from './common'
import { FindingCodeSchema, FindingSchema, VISION_CODES } from './finding'
import { InstrumentPresetSchema, MeasurementsSchema } from './instrument'

// ---------- Project ----------

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatusSchema,
  currentIssue: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>

export const ProjectStatsSchema = z.object({
  components: z.number(),
  nets: z.number(),
  testPoints: z.number(),
  captures: z.number(),
  photos: z.number(),
  /** 未解决数，对齐 docs/03 总览页 ERC-DRC 风险卡 */
  openViolations: z.number(),
  totalViolations: z.number(),
  violationsBySeverity: z.object({
    CRITICAL: z.number(),
    WARNING: z.number(),
    INFO: z.number(),
  }),
  debugSteps: z.object({ total: z.number(), completed: z.number() }),
  aiSuggestions: z.number(),
})

export const ProjectDetailSchema = ProjectSummarySchema.extend({
  stats: ProjectStatsSchema,
})
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>

// ---------- Design ----------

export const PinSchema = z.object({
  id: z.string(),
  number: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  netName: z.string().nullable(),
})

export const ComponentSchema = z.object({
  id: z.string(),
  ref: z.string(),
  value: z.string().nullable(),
  footprint: z.string().nullable(),
  partNumber: z.string().nullable(),
  manufacturer: z.string().nullable(),
  datasheetUrl: z.string().nullable(),
  category: z.string().nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  side: z.string().nullable(),
  rawJson: z.unknown().nullable(),
  pins: z.array(PinSchema),
})
export type Component = z.infer<typeof ComponentSchema>

export const NetSchema = z.object({
  id: z.string(),
  name: z.string(),
  netClass: z.string().nullable(),
  inferredRole: z.string().nullable(),
  expectedVoltage: z.string().nullable(),
  expectedFrequency: z.string().nullable(),
  pinCount: z.number(),
})
export type Net = z.infer<typeof NetSchema>

export const TestPointSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  netName: z.string().nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  source: z.string(),
})

/** GET /projects/:id/design 的聚合响应 */
export const DesignBundleSchema = z.object({
  projectId: z.string(),
  components: z.array(ComponentSchema),
  nets: z.array(NetSchema),
  testPoints: z.array(TestPointSchema),
  violations: z.array(FindingSchema),
  categories: z.array(z.object({ name: z.string(), count: z.number() })),
  ercDrc: z.object({ errors: z.number(), warnings: z.number(), violations: z.number() }),
  bomRisk: z.object({
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    total: z.number(),
  }),
})
export type DesignBundle = z.infer<typeof DesignBundleSchema>

/** AI 设计审查输出（docs/05 §7.2），P3 由 agent 产出，P1 先定型 */
export const DesignReviewSchema = z.object({
  summary: z.string().max(500),
  findings: z.array(FindingSchema).min(1).max(12),
  bomRisk: z.object({
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    total: z.number(),
  }),
  ercDrc: z.object({ errors: z.number(), warnings: z.number(), violations: z.number() }),
})
export type DesignReview = z.infer<typeof DesignReviewSchema>

// ---------- Captures ----------

export const CaptureSummarySchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['OSCILLOSCOPE', 'FFT', 'BODE', 'LOGIC', 'DMM', 'POWER']),
  scenario: ScenarioSchema.nullable(),
  netName: z.string().nullable(),
  debugStepId: z.string().nullable(),
  /**
   * 双通道时域测量，只有 OSCILLOSCOPE 有；
   * DMM / POWER / LOGIC 的测量结构完全不同，放在 rawMeasurements 里。
   */
  measurements: MeasurementsSchema.nullable(),
  rawMeasurements: z.unknown(),
  hardwareSetup: z.unknown(),
  createdAt: z.string(),
})
export type CaptureSummary = z.infer<typeof CaptureSummarySchema>

// ---------- AI Diagnosis ----------

export const RecommendationSchema = z.object({
  order: z.number().int().min(1).max(9),
  action: z.string().max(200),
  detail: z.string().max(500).optional(),
  targetNet: z.string().optional(),
  targetComponent: z.string().optional(),
  instrumentPreset: InstrumentPresetSchema.partial({ safetyNotes: true }).optional(),
})
export type Recommendation = z.infer<typeof RecommendationSchema>

/** ↔ Prisma AiDiagnosis（docs/05 §7.3）。captureId 唯一，重分析必须 upsert。 */
export const AiDiagnosisSchema = z.object({
  id: z.string().optional(),
  captureId: z.string().nullable().optional(),
  severity: SeveritySchema,
  /**
   * 根因的受控 code。评测与下游逻辑断言这个字段而不是 rootCause 文本——
   * 自然语言里出现「排除削顶」这样的否定语境时，字符串匹配会误判。
   */
  primaryCode: FindingCodeSchema.nullable().optional(),
  rootCause: z.string().min(4).max(400),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1).max(10),
  alternativeCauses: z
    .array(z.object({ cause: z.string().max(200), likelihood: z.number().min(0).max(1) }))
    .max(3)
    .default([]),
  recommendations: z.array(RecommendationSchema).min(1).max(6),
  createdAt: z.string().optional(),
})
export type AiDiagnosis = z.infer<typeof AiDiagnosisSchema>

// ---------- Debug plan ----------

export const DebugStepSchema = z.object({
  id: z.string(),
  order: z.number().int(),
  /** 显示编号，如 3.1 */
  number: z.string(),
  title: z.string(),
  objective: z.string().nullable(),
  toolHint: z.string().nullable(),
  estimateMin: z.number().nullable(),
  setup: InstrumentPresetSchema.nullable(),
  targetNet: z.string().nullable(),
  targetComponent: z.string().nullable(),
  expectedResult: z.string().nullable(),
  /** 「异常情况与下一步」的 → 条目 */
  abnormalNext: z.array(z.string()),
  status: StepStatusSchema,
  result: z.unknown().nullable(),
})
export type DebugStep = z.infer<typeof DebugStepSchema>

export const DebugPlanSchema = z.object({
  projectId: z.string(),
  issue: z.string().nullable(),
  goal: z.string().nullable(),
  totalSteps: z.number(),
  completedSteps: z.number(),
  groups: z.array(
    z.object({
      id: z.string(),
      order: z.number().int(),
      title: z.string(),
      status: StepStatusSchema,
      steps: z.array(DebugStepSchema),
    }),
  ),
})
export type DebugPlan = z.infer<typeof DebugPlanSchema>

// ---------- Activity（总览页调试记录时间线）----------

export const ActivityItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['capture', 'step', 'diagnosis']),
  title: z.string(),
  detail: z.string(),
  /** 状态 pill 文案，如「当前」「已保存」「已采纳」 */
  status: z.string(),
  tone: z.enum(['brand', 'green', 'slate']),
  timestamp: z.string(),
  /** 点击跳转目标，前端据此拼路由 */
  link: z
    .object({ page: z.enum(['bench', 'plan', 'design', 'photos']), ref: z.string().optional() })
    .nullable(),
})
export type ActivityItem = z.infer<typeof ActivityItemSchema>

// ---------- Photos ----------

export const VisualFindingSchema = z.object({
  id: z.string(),
  code: z.enum(VISION_CODES),
  title: z.string(),
  detail: z.string(),
  confidence: z.number().min(0).max(1),
  severity: VisualSeveritySchema,
  componentRef: z.string().nullable(),
  /** 置信度 < 0.6 不得标 CONFIRMED（docs/05 §8.3） */
  certainty: z.enum(['CONFIRMED', 'SUSPECTED']),
})
export type VisualFinding = z.infer<typeof VisualFindingSchema>

export const VisualFindingsSchema = z.object({
  photoId: z.string(),
  findings: z.array(VisualFindingSchema).max(8),
})
export type VisualFindings = z.infer<typeof VisualFindingsSchema>

export const PhotoAnnotationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  note: z.string().nullable(),
  componentRef: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
})

export const BoardPhotoSchema = z.object({
  id: z.string(),
  objectKey: z.string(),
  side: z.string().nullable(),
  alignment: z.unknown().nullable(),
  annotations: z.array(PhotoAnnotationSchema),
  findings: z.array(VisualFindingSchema),
  createdAt: z.string(),
})
export type BoardPhoto = z.infer<typeof BoardPhotoSchema>

// ---------- Report ----------

export const ReportTocItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.number().int().min(1).max(2),
})

export const ReportStatsSchema = z.object({
  issues: z.number(),
  resolved: z.number(),
  improvements: z.number(),
  measurements: z.number(),
  aiSuggestions: z.number(),
})

export const ReportSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  author: z.string().nullable(),
  markdown: z.string(),
  toc: z.array(ReportTocItemSchema),
  stats: ReportStatsSchema,
  createdAt: z.string(),
})
export type Report = z.infer<typeof ReportSchema>
