import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common'
import { StepStatusSchema } from '@app/contracts'
import { z } from 'zod'
import { AuthService } from '../auth/auth.service'
import { bearer } from '../auth/auth.controller'
import { CloneService } from './clone.service'
import { MutationsService } from './mutations.service'
import { ReportService } from './report.service'

const RegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
})

@Controller()
export class MutationsController {
  constructor(
    private readonly mutations: MutationsService,
    private readonly reports: ReportService,
    private readonly auth: AuthService,
    private readonly clone: CloneService,
  ) {}

  /** 克隆项目到自己名下。公共 Demo 只读，动手前先克隆。 */
  @Post('projects/:id/clone')
  async cloneProject(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.auth.verify(bearer(authorization))
    const { name } = z.object({ name: z.string().max(120).optional() }).parse(body ?? {})
    return this.clone.clone(id, user, name)
  }

  /**
   * 写操作前的归属校验。userId 为空的项目是公共 demo，任何人可写 ——
   * 内置 Demo 必须在未登录状态下也能完整演示。
   */
  private async guard(projectId: string, authorization?: string) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(projectId, user)
    return user
  }

  @Post('projects/:id/photos')
  async uploadPhoto(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        mimeType: z.string(),
        base64: z.string().min(1),
        side: z.enum(['TOP', 'BOTTOM']).optional(),
      })
      .parse(body)
    return this.mutations.uploadPhoto(id, input)
  }

  @Post('photos/:photoId/annotations')
  async createAnnotation(
    @Param('photoId') photoId: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(await this.mutations.projectIdForPhoto(photoId), authorization)
    const input = z
      .object({
        kind: z.enum(['component', 'solder', 'damage', 'question']),
        region: RegionSchema,
        note: z.string().max(500).optional(),
        componentRef: z.string().max(16).optional(),
        createdBy: z.string().max(40).optional(),
      })
      .parse(body)
    return this.mutations.createAnnotation(photoId, input)
  }

  @Delete('annotations/:id')
  async deleteAnnotation(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    // 之前这里没鉴权：任何人都能删公共 Demo 的标注
    const projectId = await this.mutations.projectIdForAnnotation(id)
    await this.guard(projectId, authorization)
    return this.mutations.deleteAnnotation(id)
  }

  @Post('projects/:id/captures')
  async saveCapture(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z
      .object({
        label: z.string().max(120).optional(),
        kind: z.enum(['OSCILLOSCOPE', 'FFT', 'BODE', 'LOGIC', 'DMM', 'POWER']).optional(),
        netName: z.string().optional(),
        debugStepId: z.string().optional(),
        hardwareSetup: z.record(z.string(), z.unknown()),
        measurements: z.record(z.string(), z.unknown()),
        waveform: z
          .object({ ch1: z.array(z.number()), ch2: z.array(z.number()), fs: z.number() })
          .optional(),
      })
      .parse(body)
    return this.mutations.saveCapture(id, input)
  }

  @Patch('debug-steps/:id')
  async updateStep(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    // step id 不带项目信息，先反查归属再鉴权 —— 否则知道 id 就能改公共 Demo
    await this.guard(await this.mutations.projectIdForStep(id), authorization)
    const input = z
      .object({
        status: StepStatusSchema.optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        objective: z.string().max(400).optional(),
        expectedResult: z.string().max(400).optional(),
      })
      .parse(body)
    return this.mutations.updateStep(id, input)
  }

  @Post('projects/:id/debug-steps')
  async createStep(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z
      .object({
        groupId: z.string().optional(),
        title: z.string().min(1).max(80),
        objective: z.string().max(400).optional(),
        toolHint: z.enum(['万用表', '示波器', 'ADALM2000', '逻辑分析仪', '目视']).optional(),
        estimateMin: z.number().int().min(1).max(60).optional(),
      })
      .parse(body)
    return this.mutations.createCustomStep(id, input)
  }

  @Post('projects/:id/reports')
  async generateReport(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    await this.guard(id, authorization)
    return this.reports.generate(id)
  }

  @Get('projects/:id/ai-thread/:mode')
  thread(@Param('id') id: string, @Param('mode') mode: string) {
    return this.reports.thread(id, mode)
  }
}
