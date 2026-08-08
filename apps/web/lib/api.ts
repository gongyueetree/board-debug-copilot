import {
  ActivityItemSchema,
  AiDiagnosisSchema,
  BoardPhotoSchema,
  CaptureSummarySchema,
  DebugPlanSchema,
  DesignBundleSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  ReportSchema,
  type ActivityItem,
  type AiDiagnosis,
  type BoardPhoto,
  type CaptureSummary,
  type Component,
  type Net,
  type DebugPlan,
  type DesignBundle,
  type ProjectDetail,
  type ProjectSummary,
  type Report,
} from '@app/contracts'
import { z } from 'zod'

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3001'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 所有响应在客户端再过一次 Zod —— 服务端已经校验过，这里是为了让类型不靠断言，
 * 并且在契约漂移时立刻炸在开发环境而不是渲染出 undefined。
 */
// 泛型必须从 schema 反推：部分 schema 用了 .default()，输入类型与输出类型不同，
// 写成 z.ZodType<T> 会把两者强制统一，导致 "Two different types with this name exist"。
async function get<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<z.infer<S>> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    throw new ApiError(`GET ${path} 失败: ${res.status}`, res.status)
  }
  return schema.parse(await res.json()) as z.infer<S>
}

export const api = {
  projects: () => get('/projects', z.array(ProjectSummarySchema)),
  project: (id: string) => get(`/projects/${id}`, ProjectDetailSchema),
  design: (id: string) => get(`/projects/${id}/design`, DesignBundleSchema),
  captures: (id: string) => get(`/projects/${id}/captures`, z.array(CaptureSummarySchema)),
  plan: (id: string) => get(`/projects/${id}/debug-steps`, DebugPlanSchema),
  activity: (id: string) => get(`/projects/${id}/activity`, z.array(ActivityItemSchema)),
  diagnosis: (id: string) => get(`/projects/${id}/diagnoses/latest`, AiDiagnosisSchema),
  photos: (id: string) => get(`/projects/${id}/photos`, z.array(BoardPhotoSchema)),
  latestReport: (id: string) => get(`/projects/${id}/reports/latest`, ReportSchema),
}

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  design: (id: string) => ['design', id] as const,
  captures: (id: string) => ['captures', id] as const,
  plan: (id: string) => ['plan', id] as const,
  activity: (id: string) => ['activity', id] as const,
  diagnosis: (id: string) => ['diagnosis', id] as const,
  photos: (id: string) => ['photos', id] as const,
  report: (id: string) => ['report', id] as const,
}

export type {
  ActivityItem,
  AiDiagnosis,
  BoardPhoto,
  CaptureSummary,
  Component,
  Net,
  DebugPlan,
  DesignBundle,
  ProjectDetail,
  ProjectSummary,
  Report,
}
