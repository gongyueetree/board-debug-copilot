import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
  StorageError,
  buildKey,
  createStorage,
  describeStorage,
  validateUpload,
  type FileKindKey,
  type ObjectHead,
  type PresignedUpload,
  type PutResult,
  type StorageAdapter,
} from '@app/storage'

/**
 * NestJS 侧的存储门面。
 *
 * 真正的 adapter 在 @app/storage —— worker 也用同一份，
 * 避免 S3 配置与 key 规范在两个进程里各写一遍。
 * 这里只负责把 StorageError 翻成 HTTP 语义。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name)
  private readonly adapter: StorageAdapter = createStorage()

  constructor() {
    const d = describeStorage()
    if (d.degraded) {
      this.logger.warn('STORAGE_ADAPTER=s3 但配置不全，已降级为 mock')
    } else {
      this.logger.log(`存储：${d.adapter}${d.bucket ? ` (${d.bucket})` : ''}`)
    }
  }

  describe() {
    return describeStorage()
  }

  validate(kind: FileKindKey, mimeType: string, sizeBytes: number): void {
    try {
      validateUpload(kind, mimeType, sizeBytes)
    } catch (err) {
      if (err instanceof StorageError) throw new BadRequestException(err.message)
      throw err
    }
  }

  key(projectId: string, scope: string, filename: string): string {
    return buildKey({ projectId, scope, filename })
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<PutResult> {
    try {
      return await this.adapter.put(key, data, mimeType)
    } catch (err) {
      if (err instanceof StorageError) throw new BadRequestException(err.message)
      throw err
    }
  }

  get(key: string): Promise<Buffer | null> {
    return this.adapter.get(key)
  }

  /** 只取元信息，不把对象内容拉进进程 */
  head(key: string): Promise<ObjectHead | null> {
    return this.adapter.head(key)
  }

  delete(key: string): Promise<void> {
    return this.adapter.delete(key)
  }

  signedReadUrl(key: string, expires = 3600): Promise<string | null> {
    return this.adapter.getSignedReadUrl(key, expires)
  }

  presignUpload(input: {
    key: string
    mimeType: string
    maxBytes: number
  }): Promise<PresignedUpload> {
    return this.adapter.createPresignedUpload(input)
  }

  /** 供多模态分析把图像转成 base64 */
  async getDataUrl(key: string, mimeType: string): Promise<string | null> {
    const buf = await this.get(key)
    return buf ? `data:${mimeType};base64,${buf.toString('base64')}` : null
  }

  /** 直接暴露 adapter，给 @app/kicad 这类只需要 get/put 的调用方 */
  raw(): StorageAdapter {
    return this.adapter
  }
}

export { LIMITS } from '@app/storage'
