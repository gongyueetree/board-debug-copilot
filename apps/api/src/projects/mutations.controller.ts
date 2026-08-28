import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common'
import { StepStatusSchema } from '@app/contracts'
import { LIMITS } from '@app/storage'
import { z } from 'zod'
import { AuthService } from '../auth/auth.service'
import { bearer } from '../auth/auth.controller'
import { CloneService } from './clone.service'
import { MutationsService } from './mutations.service'
import { PhotoUploadService } from './photo-upload.service'
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
    private readonly photoUpload: PhotoUploadService,
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

  /** 高清 PCB 照片默认走对象存储直传，避免 Vercel/Railway request body 限制。 */
  @Post('projects/:id/photos/presign')
  async presignPhoto(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        sizeBytes: z.number().int().positive().max(LIMITS.photo.maxBytes),
      })
      .parse(body)
    return this.photoUpload.presign(id, input)
  }

  /** 浏览器直传完成后只登记元数据；这里不再传图片本体。 */
  @Post('projects/:id/photos/complete')
  async completePhoto(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    await this.guard(id, authorization)
    const input = z
      .object({
        objectKey: z.string().min(1).max(500),
        filename: z.string().min(1).max(200),
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        side: z.enum(['TOP', 'BOTTOM']).optional(),
      })
      .parse(body)
    return this.photoUpload.complete(id, input)
  }

  /** base64 回落，仅用于 mock/本地环境；生产浏览器应使用 presign + complete。 */
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
