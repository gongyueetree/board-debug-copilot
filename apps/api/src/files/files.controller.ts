import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import {
  FILE_KINDS,
  LIMITS,
  StorageError,
  assertSafeObjectKey,
  projectIdFromKey,
  type FileKindKey,
} from '@app/storage'
import { z } from 'zod'
import { AuthService } from '../auth/auth.service'
import { bearer } from '../auth/auth.controller'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const MIME_BY_EXT: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  json: 'application/json',
  net: 'text/plain; charset=utf-8',
  rpt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  zip: 'application/zip',
}

/**
 * mock 存储的读写路由。
 *
 * MockStorage.getSignedReadUrl 与 createPresignedUpload 返回的就是这两个地址 ——
 * 没有它们，mock 下的 presign 流程和产物链接全是 404。
 *
 * **这不是生产的文件权限边界。** 生产用 S3/R2 时读走对象存储签发的 signed URL、
 * 写走直传，都不经过这里；对象的访问控制由桶策略和签名有效期负责。这里做的
 * 归属校验是为了让本地开发与内置 Demo 的行为和生产一致（私有项目的文件不该
 * 因为换了存储 adapter 就变成公开可读），而不是可以拿它当生产的授权层用。
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  /**
   * key 规则在 @app/storage 里，worker 与 api 共用一份。
   * 这里只负责把 StorageError 翻成 HTTP 语义。
   */
  private assertSafeKey(key: string): void {
    try {
      assertSafeObjectKey(key)
    } catch (err) {
      if (err instanceof StorageError) throw new ForbiddenException(err.message)
      throw err
    }
  }

  /**
   * 读权限：公共 Demo（userId 为空）任何人可读，私有项目要求 token 且归属匹配。
   *
   * 归属从 key 里的 projectId 段判定，而不是查 ProjectFile —— 直传完成之前
   * ProjectFile 还不存在，但对象已经在桶里了，那段窗口同样不该开放。
   */
  private async assertCanRead(key: string, token: string | undefined): Promise<void> {
    const projectId = projectIdFromKey(key)
    if (!projectId) throw new ForbiddenException('objectKey 缺少项目段')

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)
    if (project.userId === null) return

    const user = await this.auth.verify(token)
    if (!user) throw new ForbiddenException('该文件属于私有项目，请先登录')
    if (project.userId !== user.id) throw new ForbiddenException('无权读取他人项目的文件')
  }

  @Get(':encodedKey')
  @Header('cache-control', 'private, max-age=300')
  async read(
    @Param('encodedKey') encodedKey: string,
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
    // 这条 URL 会被直接丢进 <a href> 或 <img src>，那两个都带不了 header。
    // 同 Bridge 的 WebSocket：同一套 token，换个载体。
    @Query('token') queryToken?: string,
  ): Promise<void> {
    const key = decodeURIComponent(encodedKey)
    this.assertSafeKey(key)
    await this.assertCanRead(key, bearer(authorization) ?? queryToken)

    const buf = await this.storage.get(key)
    if (!buf) throw new NotFoundException(`对象不存在: ${key}`)

    // ProjectFile 记了 mimeType 就用它，否则按后缀兜底
    const record = await this.prisma.projectFile.findFirst({
      where: { objectKey: key },
      select: { mimeType: true, filename: true },
    })
    const ext = key.toLowerCase().split('.').pop() ?? ''
    const mime = record?.mimeType ?? MIME_BY_EXT[ext] ?? 'application/octet-stream'

    res.setHeader('content-type', mime)
    res.setHeader('content-length', String(buf.byteLength))
    if (record?.filename) {
      // inline：SVG 产物要能直接在浏览器里看，而不是下载
      res.setHeader(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      )
    }
    res.end(buf)
  }

  /**
   * mock 存储的直传回落。
   *
   * 只登记对象本身，不创建 ProjectFile —— 那由业务侧的 complete 接口做，
   * 它才知道这个文件属于哪个项目、算哪种 kind。
   */
  @Post('upload-fallback')
  async uploadFallback(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    if (this.storage.describe().adapter !== 'mock') {
      throw new BadRequestException(
        '回落上传仅在 STORAGE_ADAPTER=mock 下可用。S3 模式请用 presign 返回的直传 URL。',
      )
    }

    const input = z
      .object({
        objectKey: z.string().min(1).max(500),
        base64: z.string().min(1),
        mimeType: z.string().min(1),
        kind: z.enum(FILE_KINDS),
      })
      .parse(body)

    this.assertSafeKey(input.objectKey)
    // 写比读更需要归属校验：这里能覆盖别人项目下的对象
    await this.assertCanWrite(input.objectKey, authorization)

    const data = Buffer.from(input.base64, 'base64')
    // 大小与 MIME 按 kind 校验，与直传路径同一套限制
    this.storage.validate(input.kind as FileKindKey, input.mimeType, data.byteLength)

    const r = await this.storage.put(input.objectKey, data, input.mimeType)
    return { objectKey: r.objectKey, sizeBytes: r.sizeBytes, checksum: r.checksum }
  }

  /** 公共 Demo 只读，与业务写操作同一条规则（AuthService.assertCanWrite） */
  private async assertCanWrite(key: string, authorization?: string): Promise<void> {
    const projectId = projectIdFromKey(key)
    if (!projectId) throw new ForbiddenException('objectKey 缺少项目段')
    // assertCanWrite 对不存在的项目是放行的（业务侧后面还会再查一次），
    // 但这里放行就等于允许往任意 uuid 下写文件，所以先自己确认存在
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)
    const user = await this.auth.verify(bearer(authorization))
    await this.auth.assertCanWrite(projectId, user)
  }

  /** 供前端在上传前查限制，避免选完大文件才被拒 */
  @Get('limits/all')
  limits() {
    return LIMITS
  }
}
