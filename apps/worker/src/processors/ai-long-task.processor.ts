import { AiLongTaskPayloadSchema, type AiLongTaskPayload, type JobResult } from '@app/contracts'
import type { JobContext } from '../context'
import { callApi } from './internal-api'

/**
 * 长耗时 AI 任务。
 *
 * 目前 design_review / fault_diagnose 在 API 里同步跑还能接受（几秒级），
 * 这个 processor 存在是为了两种场景：批量重跑（换 provider 后全量重审）
 * 和大工程（组件上千时上下文装配本身就慢）。
 *
 * worker 不直接引 @app/ai：那会把 provider 配置、守卫管线、落库逻辑
 * 在两个进程里各维护一份。改为回调 api 的内部端点，单一实现。
 */
export async function aiLongTaskProcessor(raw: unknown, ctx: JobContext): Promise<JobResult> {
  const started = Date.now()
  let payload: AiLongTaskPayload

  try {
    payload = AiLongTaskPayloadSchema.parse(raw)
  } catch (err) {
    return {
      ok: false,
      summary: 'payload 校验失败',
      error: (err as Error).message.slice(0, 2000),
      data: {},
      durationMs: Date.now() - started,
    }
  }

  const route =
    payload.intent === 'design_review'
      ? {
          path: '/ai/design-review',
          body: { projectId: payload.projectId, persist: payload.persist },
        }
      : payload.intent === 'fault_diagnose'
        ? {
            path: '/ai/analyze-capture',
            body: { captureId: payload.targetId, persist: payload.persist },
          }
        : { path: `/projects/${payload.projectId}/reports`, body: { _internal: true } }

  ctx.log(`ai.long-task 开始 intent=${payload.intent}`)

  try {
    const data = await callApi(route.path, route.body)

    ctx.log(`ai.long-task 完成 intent=${payload.intent}`)
    return {
      ok: true,
      summary: `${payload.intent} 完成`,
      error: null,
      data,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000)
    ctx.log(`ai.long-task 失败: ${message}`)
    return {
      ok: false,
      summary: `${payload.intent} 异常`,
      error: message,
      data: {},
      durationMs: Date.now() - started,
    }
  }
}
