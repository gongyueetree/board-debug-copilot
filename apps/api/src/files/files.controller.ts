import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { FILE_KINDS, LIMITS, type FileKindKey } from '@app/storage'
import { z } from 'zod'
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
 * 生产用 S3/R2 时读走真正的 signed URL，不经过这里；上传走对象存储直传。
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * key 必须限制在 projects/ 前缀内。
   * 否则用户可以传任意路径，把本地盘上的其它文件读出来或写进去。
   */
  private assertSafeKey(key: string): void {
    if (!key.startsWith('projects/')) {
      throw new ForbiddenException('objectKey 必须位于 projects/ 前缀下')
    }
    if (key.includes('..') || key.includes('\0')) {
      throw new ForbiddenException('objectKey 含非法路径片段')
    }
  }

  @Get(':encodedKey')
  @Header('cache-control', 'private, max-age=300')
  async read(@Param('encodedKey') encodedKey: string, @Res() res: Response): Promise<void> {
    const key = decodeURIComponent(encodedKey)
    this.assertSafeKey(key)

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
  async uploadFallback(@Body() body: unknown) {
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

    const data = Buffer.from(input.base64, 'base64')
    // 大小与 MIME 按 kind 校验，与直传路径同一套限制
    this.storage.validate(input.kind as FileKindKey, input.mimeType, data.byteLength)

    const r = await this.storage.put(input.objectKey, data, input.mimeType)
    return { objectKey: r.objectKey, sizeBytes: r.sizeBytes, checksum: r.checksum }
  }

  /** 供前端在上传前查限制，避免选完大文件才被拒 */
  @Get('limits/all')
  limits() {
    return LIMITS
  }
}
