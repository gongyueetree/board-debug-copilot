import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

@Injectable()
export class PhotoUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async presign(
    projectId: string,
    input: { filename: string; mimeType: string; sizeBytes: number },
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)

    this.storage.validate('photo', input.mimeType, input.sizeBytes)
    const key = this.storage.key(projectId, 'photos', input.filename)
    return this.storage.presignUpload({
      key,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })
  }

  async complete(
    projectId: string,
    input: { objectKey: string; filename: string; mimeType: string; side?: 'TOP' | 'BOTTOM' },
  ) {
    const prefix = `projects/${projectId}/photos/`
    if (!input.objectKey.startsWith(prefix)) {
      throw new BadRequestException('照片 objectKey 与当前项目不匹配')
    }

    const head = await this.storage.head(input.objectKey)
    if (!head) throw new NotFoundException('直传对象不存在，请重新拍照上传')

    const mimeType = head.mimeType ?? input.mimeType
    try {
      this.storage.validate('photo', mimeType, head.sizeBytes)
    } catch (err) {
      await this.storage.delete(input.objectKey).catch(() => {})
      throw err
    }

    const [photo] = await this.prisma.$transaction([
      this.prisma.boardPhoto.create({
        data: { projectId, objectKey: input.objectKey, side: input.side ?? 'TOP' },
      }),
      this.prisma.projectFile.create({
        data: {
          projectId,
          kind: 'PCB_PHOTO',
          filename: input.filename,
          objectKey: input.objectKey,
          mimeType,
          sizeBytes: head.sizeBytes,
          parseStatus: 'OK',
        },
      }),
    ])

    return { id: photo.id, objectKey: input.objectKey, sizeBytes: head.sizeBytes }
  }
}
