import {
  KicadParsePayloadSchema,
  type JobResult,
  type KicadParsePayload,
} from '@app/contracts'
import { parseKicadArchive } from '@app/kicad'
import { createStorage } from '@app/storage'
import type { JobContext } from '../context'

/**
 * KiCad 工程解析。
 *
 * 长任务从请求生命周期里移出来的原因很实际：kicad-cli 跑 ERC + DRC + 两次 SVG
 * 导出，大工程要几十秒，HTTP 请求撑不住，Railway 网关也会先超时。
 *
 * 失败不抛异常 —— parseStatus 与 parseLog 必须落库，否则用户只看到一个
 * 永远停在 PARSING 的项目而不知道为什么（CLAUDE.md 硬性原则 #8）。
 */
export async function kicadParseProcessor(
  raw: unknown,
  ctx: JobContext,
): Promise<JobResult> {
  const started = Date.now()
  let payload: KicadParsePayload

  try {
    payload = KicadParsePayloadSchema.parse(raw)
  } catch (err) {
    return {
      ok: false,
      summary: 'payload 校验失败',
      error: (err as Error).message.slice(0, 2000),
      data: {},
      durationMs: Date.now() - started,
    }
  }

  const { projectId, objectKey, fileId } = payload
  ctx.log(`kicad.parse 开始 project=${projectId} key=${objectKey}`)

  try {
    const outcome = await parseKicadArchive({
      projectId,
      objectKey,
      prisma: ctx.prisma,
      storage: createStorage(),
    })

    await ctx.prisma.projectFile.update({
      where: { id: fileId },
      data: { parseStatus: outcome.status, parseLog: outcome.log },
    })
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { status: outcome.status === 'READY' ? 'READY' : 'ERROR' },
    })

    ctx.log(
      `kicad.parse 完成 mode=${outcome.mode} components=${outcome.components} nets=${outcome.nets}`,
    )
    return {
      ok: outcome.status === 'READY',
      summary: `${outcome.mode} 模式解析：${outcome.components} 组件 / ${outcome.nets} 网络 / ${outcome.artifacts} 产物`,
      error: outcome.status === 'READY' ? null : '解析未产出结构化数据，详见 parseLog',
      data: {
        mode: outcome.mode,
        components: outcome.components,
        nets: outcome.nets,
        violations: outcome.violations,
        artifacts: outcome.artifacts,
        designVersion: outcome.designVersion,
      },
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000)
    // 兜底：连 parseKicadArchive 本身都炸了也要把原因写回去
    await ctx.prisma.projectFile
      .update({
        where: { id: fileId },
        data: { parseStatus: 'ERROR', parseLog: `[ERR] worker 异常: ${message}` },
      })
      .catch(() => {})
    await ctx.prisma.project
      .update({ where: { id: projectId }, data: { status: 'ERROR' } })
      .catch(() => {})

    ctx.log(`kicad.parse 失败: ${message}`)
    return {
      ok: false,
      summary: 'KiCad 解析异常',
      error: message,
      data: {},
      durationMs: Date.now() - started,
    }
  }
}
