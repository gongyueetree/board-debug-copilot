import { Body, Controller, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { DesignReviewSchema, type DesignReview } from '@app/contracts'
import { z } from 'zod'
import { AiService } from './ai.service'

const ChatBodySchema = z.object({
  projectId: z.string(),
  message: z.string().min(1).max(2000),
  mode: z.string().optional(),
  scenario: z.string().optional(),
})

const ReviewBodySchema = z.object({
  projectId: z.string(),
  persist: z.boolean().optional(),
})

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('design-review')
  async designReview(@Body() body: unknown): Promise<DesignReview> {
    const { projectId, persist } = ReviewBodySchema.parse(body)
    return DesignReviewSchema.parse(await this.ai.designReview(projectId, persist ?? false))
  }

  /** SSE 流式回复。Railway 上无限制，Vercel 侧不经过（前端直连 api）。 */
  @Post('chat')
  async chat(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const params = ChatBodySchema.parse(body)

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    // 禁止中间代理缓冲，否则流式会被攒成一整包
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
