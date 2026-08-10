import {
  ReportGeneratePayloadSchema,
  type JobResult,
  type ReportGeneratePayload,
} from '@app/contracts'
import type { JobContext } from '../context'
import { callApi } from './internal-api'

/**
 * 报告生成。纯聚合，不调 LLM —— 报告里每个数字都能追溯到某张表
 * （docs/05 §8.3：只汇总已落库事实，不新增结论）。
 *
 * 异步化的原因：大项目要扫全部违规、捕获、步骤、照片、诊断，
 * 请求里跑会拖慢页面，而用户不需要同步等结果。
 */
export async function reportGenerateProcessor(
  raw: unknown,
  ctx: JobContext,
): Promise<JobResult> {
  const started = Date.now()
  let payload: ReportGeneratePayload

  try {
    payload = ReportGeneratePayloadSchema.parse(raw)
  } catch (err) {
    return {
      ok: false,
      summary: 'payload 校验失败',
      error: (err as Error).message.slice(0, 2000),
      data: {},
      durationMs: Date.now() - started,
    }
  }

  ctx.log(`report.generate 开始 project=${payload.projectId}`)

  try {
    const r = await callApi(`/projects/${payload.projectId}/reports`, {
      author: payload.author,
      _internal: true,
    })
    ctx.log(`report.generate 完成 ${String(r.version)}`)
    return {
      ok: true,
      summary: `生成 ${String(r.version)}，${String(r.sections)} 章`,
      error: null,
      data: r,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000)
    // 失败要留痕：占位记录存在时把原因写进正文，避免 UI 一直转圈
    if (payload.reportId) {
      await ctx.prisma.debugReport
        .update({
          where: { id: payload.reportId },
          data: { markdown: `# 报告生成失败\n\n${message}` },
        })
        .catch(() => {})
    }
    ctx.log(`report.generate 失败: ${message}`)
    return {
      ok: false,
      summary: '报告生成异常',
      error: message,
      data: {},
      durationMs: Date.now() - started,
    }
  }
}
