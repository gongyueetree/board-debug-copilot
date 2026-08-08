import 'server-only'
import { api } from './api'

/**
 * 服务端预取，结果作为 TanStack Query 的 initialData 下发。
 * 这样首屏直接是内容而不是骨架，客户端再接管刷新。
 *
 * API 暂时不可用时返回 null，页面降级渲染而不是整页 500 ——
 * 对应 CLAUDE.md 硬性原则 #8 的前端侧。
 */
export async function prefetch<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    console.error('[prefetch] 失败:', (err as Error).message)
    return null
  }
}

export async function loadOverview(projectId: string) {
  const [project, design, captures, activity, diagnosis, photos] = await Promise.all([
    prefetch(() => api.project(projectId)),
    prefetch(() => api.design(projectId)),
    prefetch(() => api.captures(projectId)),
    prefetch(() => api.activity(projectId)),
    prefetch(() => api.diagnosis(projectId)),
    prefetch(() => api.photos(projectId)),
  ])
  return { project, design, captures, activity, diagnosis, photos }
}
