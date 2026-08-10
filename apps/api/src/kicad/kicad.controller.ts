import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common'
import { LIMITS } from '@app/storage'
import { z } from 'zod'
import { AuthService } from '../auth/auth.service'
import { bearer } from '../auth/auth.controller'
import { PrismaService } from '../prisma/prisma.service'
import { KicadService } from './kicad.service'

@Controller('projects/:id/kicad')
export class KicadController {
  constructor(
    private readonly kicad: KicadService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 直传签名。浏览器 PUT 到对象存储，zip 不经过 api 进程 ——
   * 100MB 走 base64 过一遍 Node 是明确要避免的方案。
   */
  @Post('presign')
  async presign(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(id, user)
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        mimeType: z.string().default('application/zip'),
        sizeBytes: z.number().int().positive().max(LIMITS.zip.maxBytes),
      })
      .parse(body)
    return this.kicad.presignUpload(id, input)
  }

  /** 直传完成后回调：登记 ProjectFile 并入队解析 */
  @Post('complete')
  async complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(id, user)
    const input = z
      .object({
        objectKey: z.string().min(1),
        filename: z.string().min(1).max(200),
        sizeBytes: z.number().int().positive(),
      })
      .parse(body)
    return this.kicad.completeUpload(id, input)
  }

  @Post('upload')
  async upload(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(id, user)
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        base64: z.string().min(1),
        mimeType: z.string().optional(),
      })
      .parse(body)
    return this.kicad.uploadAndParse(id, input)
  }

  /** 解析状态、parseLog 与产物列表 */
  @Get('status')
  status(@Param('id') id: string) {
    return this.kicad.status(id)
  }

  /** 重新解析已上传的工程 */
  @Post('reparse')
  async reparse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(id, user)
    const { fileId } = z.object({ fileId: z.string().uuid() }).parse(body)
    return this.kicad.reparse(id, fileId)
  }

  /** 产物下载签名 URL */
  @Get('artifacts/:fileId')
  artifact(@Param('fileId') fileId: string) {
    return this.kicad.artifactUrl(fileId)
  }
}
