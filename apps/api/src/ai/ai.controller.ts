import { Body, Controller, Get, Post, Res } from '@nestjs/common'
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
import { AssemblyAlignmentService } from './assembly-alignment.service'
import { AssemblyInspectionService } from './assembly-inspection.service'

const LabSightInvokeSchema = z.object({
  projectId: z.string().min(1),
  action: z.enum([
    'chat',
    'measure_guide',
    'design_review',
    'analyze_photo',
    'assembly_align',
    'assembly_inspect',
    'analyze_capture',
  ]),
  question: z.string().min(1).max(2000).optional(),
  photoId: z.string().min(1).optional(),
  captureId: z.string().min(1).optional(),
  persist: z.boolean().optional(),
})

@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly alignment: AssemblyAlignmentService,
    private readonly assembly: AssemblyInspectionService,
  ) {}

  /**
   * ezPLM / external host discovery endpoint.
   *
   * LabSight is deliberately exposed as one callable engineering agent instead of
   * asking ezPLM to know seven internal endpoints. Actions that can change PLM
   * state remain suggestion-only; this endpoint only reads context, creates AI
   * results, or persists evidence in the existing Board Debug Copilot stores.
   */
  @Get('labsight-agent/manifest')
  labsightManifest() {
    return {
      id: 'A6',
      slug: 'labsight-debug',
      name: 'LabSight 调试 Agent',
      version: '0.1.0',
      mountPoint: 'project/labsight',
      modes: ['live_debug', 'pcb_compare'],
      context: [
        'project',
        'design_version',
        'components',
        'nets',
        'test_points',
        'photos',
        'captures',
        'diagnoses',
        'debug_steps',
        'activity_timeline',
      ],
      capabilities: [
        { id: 'chat', label: '工程上下文问答', available: true },
        { id: 'measure_guide', label: '下一测量点建议', available: true },
        { id: 'design_review', label: '设计审查', available: true },
        { id: 'analyze_photo', label: 'PCB / 仪器照片分析', available: true },
        { id: 'assembly_align', label: 'KiCad ↔ 实物 PCB 配准', available: true },
        { id: 'assembly_inspect', label: 'Footprint 装配检查', available: true },
        { id: 'analyze_capture', label: '波形 / 测量诊断', available: true },
        { id: 'create_issue_draft', label: '生成 Issue 草稿', available: false, phase: 'P1' },
        { id: 'create_eco_draft', label: '生成 ECO 草稿', available: false, phase: 'P1' },
        { id: 'golden_board_compare', label: 'Golden Board 对比', available: false, phase: 'P2' },
      ],
      policy: {
        writes: 'suggest_only',
        humanConfirmationRequired: true,
        evidenceRequired: true,
      },
    }
  }

  /**
   * Single JSON invocation surface for ezPLM. Chat is collected from the existing
   * SSE agent so server-to-server callers do not need to implement SSE just to
   * invoke LabSight. The native /ai/chat endpoint remains available to the UI for
   * realtime streaming.
   */
  @Post('labsight-agent/invoke')
  async invokeLabSight(@Body() body: unknown) {
    const p = LabSightInvokeSchema.parse(body)

    if (p.action === 'chat') {
      const narration: string[] = []
      const tools: unknown[] = []
      const cards: unknown[] = []
      let meta: unknown = null
      let result: unknown = null
      for await (const ev of this.ai.chat({
        projectId: p.projectId,
        message: p.question ?? '请基于当前项目证据给出下一步调试建议。',
        mode: 'labsight',
      })) {
        if (ev.event === 'narration') {
          const d = ev.data as { delta?: string }
          if (d?.delta) narration.push(d.delta)
        } else if (ev.event === 'tool') tools.push(ev.data)
        else if (ev.event === 'card') cards.push(ev.data)
        else if (ev.event === 'meta') meta = ev.data
        else if (ev.event === 'result') result = ev.data
      }
      return {
        ok: true,
        agent: 'A6',
        action: p.action,
        narration: narration.join(''),
        meta,
        tools,
        cards,
        result,
      }
    }

    if (p.action === 'measure_guide') {
      if (!p.question) throw new Error('measure_guide 需要 question')
      return {
        ok: true,
        agent: 'A6',
        action: p.action,
        result: await this.ai.measureGuide(p.projectId, p.question),
      }
    }

    if (p.action === 'design_review') {
      return {
        ok: true,
        agent: 'A6',
        action: p.action,
        result: DesignReviewSchema.parse(await this.ai.designReview(p.projectId, p.persist ?? false)),
      }
    }

    if (p.action === 'analyze_photo') {
      if (!p.photoId) throw new Error('analyze_photo 需要 photoId')
      return {
        ok: true,
        agent: 'A6',
        action: p.action,
        result: VisualFindingsSchema.parse(await this.ai.analyzePhoto(p.photoId, p.persist ?? true)),
      }
    }

    if (p.action === 'assembly_align') {
      if (!p.photoId) throw new Error('assembly_align 需要 photoId')
      return { ok: true, agent: 'A6', action: p.action, result: await this.alignment.align(p.photoId, false) }
    }

    if (p.action === 'assembly_inspect') {
      if (!p.photoId) throw new Error('assembly_inspect 需要 photoId')
      return { ok: true, agent: 'A6', action: p.action, result: await this.assembly.inspect(p.photoId) }
    }

    if (!p.captureId) throw new Error('analyze_capture 需要 captureId')
    return {
      ok: true,
      agent: 'A6',
      action: p.action,
      result: AiDiagnosisSchema.parse(await this.ai.analyzeCapture(p.captureId, p.persist ?? true)),
    }
  }

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

  /** P1.5: register KiCad board coordinates onto the physical PCB photo and generate footprint ROIs. */
  @Post('assembly-align')
  async assemblyAlign(@Body() body: unknown) {
    const { photoId, force } = z.object({ photoId: z.string().min(1), force: z.boolean().optional() }).parse(body)
    return this.alignment.align(photoId, force ?? false)
  }

  /**
   * P1 装配检查独立端点：不改变原 analyze-photo 行为，避免影响已验证测试链路。
   * P1.5 会先自动配准，再按每个 footprint ROI 判断漏装。
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