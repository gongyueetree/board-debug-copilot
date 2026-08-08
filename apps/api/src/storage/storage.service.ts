import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 对象存储 adapter。STORAGE_ADAPTER=mock 落本地盘，=s3 走 S3 兼容端点。
 * MOCK_MODE 下全链路无外部依赖（CLAUDE.md 硬性原则 #2）。
 */

/** 上传限制（CLAUDE.md 硬性原则 #7） */
export const LIMITS = {
  zip: { maxBytes: 100 * 1024 * 1024, mimes: ['application/zip', 'application/x-zip-compressed'] },
  photo: {
    maxBytes: 20 * 1024 * 1024,
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
  },
} as const

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name)
  private readonly adapter = process.env.STORAGE_ADAPTER ?? 'mock'
  private readonly root = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage')
  /** 无盘环境（Railway 无卷）时退回内存，重启即丢，仅用于演示 */
  private readonly memory = new Map<string, Buffer>()

  validate(kind: keyof typeof LIMITS, mimeType: string, sizeBytes: number) {
    const limit = LIMITS[kind]
    if (!(limit.mimes as readonly string[]).includes(mimeType)) {
      throw new BadRequestException(
        `不支持的文件类型 ${mimeType}，允许：${limit.mimes.join('、')}`,
      )
    }
    if (sizeBytes > limit.maxBytes) {
      throw new BadRequestException(
        `文件过大 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB，上限 ${limit.maxBytes / 1024 / 1024}MB`,
      )
    }
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<{ objectKey: string; checksum: string }> {
    const checksum = createHash('sha256').update(data).digest('hex').slice(0, 16)

    if (this.adapter === 'mock') {
      try {
        const path = join(this.root, key)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, data)
      } catch (err) {
        this.logger.warn(`写盘失败，退回内存：${(err as Error).message}`)
        this.memory.set(key, data)
      }
      return { objectKey: key, checksum }
    }

    throw new BadRequestException(`STORAGE_ADAPTER=${this.adapter} 尚未实现（S3 接入见 docs/04）`)
  }

  /** 读回内容；供 vision 分析把图片转成 base64 */
  async get(key: string): Promise<Buffer | null> {
    const mem = this.memory.get(key)
    if (mem) return mem
    try {
      return await readFile(join(this.root, key))
    } catch {
      return null
    }
  }

  async getDataUrl(key: string, mimeType: string): Promise<string | null> {
    const buf = await this.get(key)
    return buf ? `data:${mimeType};base64,${buf.toString('base64')}` : null
  }
}
