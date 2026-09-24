import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common'
import { z } from 'zod'
import { AuthService } from '../auth/auth.service'
import { bearer } from '../auth/auth.controller'
import { LabSightWorkflowService } from './labsight-workflow.service'

const EvidenceSchema = z.object({
  kind: z.enum(['IMAGE', 'MEASUREMENT', 'WAVEFORM', 'KICAD', 'VOICE', 'SESSION', 'INSTRUMENT', 'DIAGNOSIS', 'TEST_RESULT']),
  ref: z.string().min(1).max(300),
  sourceType: z.string().min(1).max(60),
  sourceId: z.string().max(120).optional(),
  componentId: z.string().optional(),
  pinId: z.string().optional(),
  netId: z.string().optional(),
  testPointId: z.string().optional(),
  debugStepId: z.string().optional(),
  excerpt: z.string().max(1200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

@Controller()
export class LabSightWorkflowController {
  constructor(
    private readonly workflow: LabSightWorkflowService,
    private readonly auth: AuthService,
  ) {}

  private async guard(projectId: string, authorization?: string) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(projectId, user)
  }

  @Get('projects/:id/boards')
  listBoards(@Param('id') id: string) {
    return this.workflow.listBoards(id)
  }

  @Post('projects/:id/boards')
  async createBoard(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z.object({
      serialNo: z.string().min(1).max(100).optional(),
      batchNo: z.string().max(100).optional(),
      label: z.string().max(120).optional(),
      isGolden: z.boolean().optional(),
    }).parse(body)
    return this.workflow.createBoard(id, input)
  }

  @Get('projects/:id/debug-sessions')
  listSessions(@Param('id') id: string) {
    return this.workflow.listSessions(id)
  }

  @Post('projects/:id/debug-sessions')
  async createSession(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z.object({
      boardId: z.string().optional(),
      title: z.string().min(1).max(160),
      issue: z.string().max(1000).optional(),
      goal: z.string().max(1000).optional(),
      ownerId: z.string().max(120).optional(),
    }).parse(body)
    return this.workflow.createSession(id, input)
  }

  @Patch('debug-sessions/:id')
  async updateSession(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForSession(id)
    await this.guard(projectId, authorization)
    const input = z.object({
      title: z.string().min(1).max(160).optional(),
      issue: z.string().max(1000).optional(),
      goal: z.string().max(1000).optional(),
      status: z.enum(['OPEN', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
      rootCauseCode: z.string().max(120).optional(),
    }).parse(body)
    return this.workflow.updateSession(id, input)
  }

  @Get('debug-sessions/:id/evidence')
  evidence(@Param('id') id: string) {
    return this.workflow.listEvidence(id)
  }

  @Post('debug-sessions/:id/evidence')
  async addEvidence(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForSession(id)
    await this.guard(projectId, authorization)
    return this.workflow.addEvidence(id, EvidenceSchema.parse(body))
  }

  @Post('debug-sessions/:id/captures/:captureId/bind')
  async bindCapture(
    @Param('id') id: string,
    @Param('captureId') captureId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForSession(id)
    await this.guard(projectId, authorization)
    const input = EvidenceSchema.omit({ kind: true, sourceType: true, sourceId: true }).parse(body)
    return this.workflow.bindCapture(id, captureId, input)
  }

  @Post('projects/:id/labsight/drafts/:kind')
  async createDraft(
    @Param('id') id: string,
    @Param('kind') kindRaw: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const kind = z.enum(['ISSUE', 'ECO']).parse(kindRaw.toUpperCase())
    const input = z.object({
      sessionId: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
    }).parse(body)
    return this.workflow.createDraft(id, kind, input)
  }

  @Post('labsight/drafts/:id/ack')
  async acknowledgeDraft(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForDraft(id)
    await this.guard(projectId, authorization)
    const input = z.object({
      externalObjectId: z.string().min(1).max(160),
      accepted: z.boolean().optional(),
    }).parse(body)
    return this.workflow.acknowledgeDraft(id, input)
  }

  @Post('debug-sessions/:id/hypotheses')
  async addHypothesis(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForSession(id)
    await this.guard(projectId, authorization)
    const input = z.object({
      statement: z.string().min(1).max(1200),
      expectedObservation: z.string().max(1200).optional(),
      confidence: z.number().min(0).max(1),
    }).parse(body)
    return this.workflow.addHypothesis(id, input)
  }

  @Post('debug-sessions/:id/next-best-test')
  async nextBestTest(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    const projectId = await this.workflow.projectIdForSession(id)
    await this.guard(projectId, authorization)
    return this.workflow.nextBestTest(id)
  }

  @Post('projects/:id/labsight/golden-compare')
  async compareGolden(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z.object({
      sessionId: z.string().min(1),
      goldenBoardId: z.string().min(1),
      targetBoardId: z.string().optional(),
    }).parse(body)
    return this.workflow.compareGolden(id, input)
  }
}
