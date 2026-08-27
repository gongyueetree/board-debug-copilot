import { Body, Controller, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  AiDiagnosisSchema,
  DesignReviewSchema,
  VisualFindingsSchema,
  type AiDiagnosis,
  type DesignReview,
  type VisualFindings,
} from '@app/contracts'
import { z } from 'zod'
import { AiService } from './ai.service'
import { AssemblyInspectionService } from './assembly-inspection.service'

@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly assembly: AssemblyInspectionService,
  ) {}

  @Post('design-review')
  async designReview(@Body() body: unknown): Promise<DesignReview> {
    const { projectId, persist } = z
      .object({ projectId: z.string(), persist: z.boolean().optional() })
      .parse(body)
    return DesignReviewSchema.parse(await this.ai.designReview(projectId, persist ?? false))
  }

  @Post('analyze-capture')
  async analyzeCapture(@Body() body: unknown): Promise<AiDiagnosis> {
    const { captureId, persist } = z
      .object({ captureId: z.string(), persist: z.boolean().optional() })
      .parse(body)
    return AiDiagnosisSchema.parse(await this.ai.analyzeCapture(captureId, persist ?? true))
  }

  @Post('analyze-photo')
  async analyzePhoto(@Body() body: unknown): Promise<VisualFindings> {
    const { photoId, persist } = z
      .object({ photoId: z.string(), persist: z.boolean().optional() })
      .parse(body)
    return VisualFindingsSchema.parse(await this.ai.analyzePhoto(photoId, persist ?? true))
  }

  /**
   * P1 装配检查独立端点：不改变原 analyze-photo 行为，避免影响已验证测试链路。
   * 依据 .kicad_pcb footprint/pad 分组，只回答漏装与无法确认项。
   */
  @Post('assembly-inspect')
  async assemblyInspect(@Body() body: unknown) {
    const { photoId } = z.object({ photoId: z.string().min(1) }).parse(body)
    return this.assembly.inspect(photoId)
  }

  @Post('measure-guide')
  async measureGuide(@Body() body: unknown) {
    const { projectId, question } = z
      .object({ projectId: z.string(), question: z.string().min(1).max(500) })
      .parse(body)
    return this.ai.measureGuide(projectId, question)
  }

  /** SSE 流式回复。Railway 上无限制，前端直连 api 不经 Vercel。 */
  @Post('chat')
  async chat(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const params = z
      .object({
        projectId: z.string(),
        message: z.string().min(1).max(2000),
        mode: z.string().optional(),
        scenario: z.string().optional(),
      })
      .parse(body)

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    try {
      for await (const ev of this.ai.chat(params)) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
      }
    } catch (err) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ code: 'STREAM_ERROR', message: (err as Error).message })}\n\n`,
      )
    } finally {
      res.end()
    }
  }
}
