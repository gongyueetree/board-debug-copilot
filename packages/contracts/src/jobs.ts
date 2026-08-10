import { z } from 'zod'

/**
 * 异步任务契约。API 入队、worker 出队，两侧共用同一份 schema ——
 * 队列是进程边界，payload 不校验就等于没有类型。
 */
export const QUEUE_NAME = 'bdc-jobs'

export const JOB_TYPES = [
  'kicad.parse',
  'report.generate',
  'ai.long-task',
  'parts.match-bom',
] as const
export const JobTypeSchema = z.enum(JOB_TYPES)
export type JobType = z.infer<typeof JobTypeSchema>

export const KicadParsePayloadSchema = z.object({
  projectId: z.string().uuid(),
  /** 对象存储里的 zip */
  objectKey: z.string().min(1),
  /** 关联的 ProjectFile，用于回写 parseStatus / parseLog */
  fileId: z.string().uuid(),
})
export type KicadParsePayload = z.infer<typeof KicadParsePayloadSchema>

export const ReportGeneratePayloadSchema = z.object({
  projectId: z.string().uuid(),
  /** 已存在的报告 id：占位记录，任务完成后填正文 */
  reportId: z.string().uuid().optional(),
  author: z.string().max(60).optional(),
})
export type ReportGeneratePayload = z.infer<typeof ReportGeneratePayloadSchema>

export const AiLongTaskPayloadSchema = z.object({
  projectId: z.string().uuid(),
  intent: z.enum(['design_review', 'fault_diagnose', 'report_generate']),
  /** 关联对象，按 intent 不同含义不同 */
  targetId: z.string().optional(),
  persist: z.boolean().default(true),
})
export type AiLongTaskPayload = z.infer<typeof AiLongTaskPayloadSchema>

export const PartsMatchPayloadSchema = z.object({
  projectId: z.string().uuid(),
  /** 不传则匹配全部组件 */
  componentRefs: z.array(z.string()).optional(),
})
export type PartsMatchPayload = z.infer<typeof PartsMatchPayloadSchema>

export const JOB_PAYLOAD_SCHEMAS = {
  'kicad.parse': KicadParsePayloadSchema,
  'report.generate': ReportGeneratePayloadSchema,
  'ai.long-task': AiLongTaskPayloadSchema,
  'parts.match-bom': PartsMatchPayloadSchema,
} as const

/** 所有 processor 的统一返回。失败也要有结构，不能只抛异常。 */
export const JobResultSchema = z.object({
  ok: z.boolean(),
  /** 摘要，进 worker 日志与 UI 状态 */
  summary: z.string().max(500),
  /** 失败原因，成功时为 null */
  error: z.string().max(2000).nullable().default(null),
  /** 任务特定产出，如解析出的组件数、生成的报告版本 */
  data: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().int().nonnegative(),
})
export type JobResult = z.infer<typeof JobResultSchema>

/** 队列不可用时 API 的降级标记：调用方据此决定是否同步执行 */
export const EnqueueResultSchema = z.object({
  enqueued: z.boolean(),
  jobId: z.string().nullable(),
  /** 无 Redis 时为 true，任务已改为同步执行或跳过 */
  degraded: z.boolean(),
  reason: z.string().nullable().default(null),
})
export type EnqueueResult = z.infer<typeof EnqueueResultSchema>
