import { PartsMatchPayloadSchema, type JobResult, type PartsMatchPayload } from '@app/contracts'
import type { JobContext } from '../context'
import { callApi } from './internal-api'

/**
 * BOM 与元器件库匹配。
 *
 * 走 PartsDatabaseAdapter，MOCK_MODE 下用内置常识参数
 * （docs/00 §12：不要假装有真实库存和价格）。
 * 接真实百万器件库后只需换 adapter。
 */
export async function partsMatchProcessor(raw: unknown, ctx: JobContext): Promise<JobResult> {
  const started = Date.now()
  let payload: PartsMatchPayload

  try {
    payload = PartsMatchPayloadSchema.parse(raw)
  } catch (err) {
    return {
      ok: false,
      summary: 'payload 校验失败',
      error: (err as Error).message.slice(0, 2000),
      data: {},
      durationMs: Date.now() - started,
    }
  }

  ctx.log(`parts.match-bom 开始 project=${payload.projectId}`)

  try {
    const r = await callApi(`/projects/${payload.projectId}/parts/match`, {
      componentRefs: payload.componentRefs,
      _internal: true,
    })
    ctx.log(`parts.match-bom 完成：${String(r.matched)}/${String(r.total)} 命中`)
    return {
      ok: true,
      summary: `${String(r.matched)}/${String(r.total)} 个器件匹配到参数`,
      error: null,
      data: r,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000)
    ctx.log(`parts.match-bom 失败: ${message}`)
    return {
      ok: false,
      summary: 'BOM 匹配异常',
      error: message,
      data: {},
      durationMs: Date.now() - started,
    }
  }
}
