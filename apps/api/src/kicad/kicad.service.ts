import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { LIMITS } from '@app/storage'
import { parseKicadArchive } from '@app/kicad'
import { PrismaService } from '../prisma/prisma.service'
import { QueueService } from '../queue/queue.service'
import { StorageService } from '../storage/storage.service'

export interface UploadHandoff {
  fileId: string
  objectKey: string
  status: 'QUEUED' | 'PARSING' | 'READY' | 'ERROR'
  /** 队列不可用时为 true，解析已同步执行 */
  degraded: boolean
  jobId: string | null
  message: string
}

/**
 * KiCad 上传入口。
 *
 * 这里只做三件事：校验、登记 ProjectFile、入队。真正的解压与 kicad-cli
 * 在 worker 里跑 —— 大工程 ERC+DRC+两次 SVG 导出要几十秒，
 * 放在请求生命周期里会被网关先超时掐掉。
 *
 * 没有 Redis 时同步兜底执行，保证本地开发与演示不受影响。
 */
@Injectable()
export class KicadService {
  private readonly logger = new Logger(KicadService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  /** 直传签名 */
  async presignUpload(
    projectId: string,
    input: { filename: string; mimeType: string; sizeBytes: number },
  ) {
    await this.assertProject(projectId)
    this.storage.validate('zip', input.mimeType, input.sizeBytes)

    const key = this.storage.key(projectId, 'kicad', input.filename)
    const presigned = await this.storage.presignUpload({
      key,
      mimeType: input.mimeType,
      maxBytes: LIMITS.zip.maxBytes,
    })

    return {
      ...presigned,
      // mock 模式没有真正的直传，前端据此回落到 base64
      hint: presigned.isFallback
        ? 'mock 存储无直传能力，请改用 POST /kicad/upload 的 base64 回落'
        : '用 PUT 把文件发到该 URL，完成后调用 /kicad/complete',
    }
  }

  /** 直传完成回调 */
  async completeUpload(
    projectId: string,
    input: { objectKey: string; filename: string; sizeBytes: number },
  ): Promise<UploadHandoff> {
    await this.assertProject(projectId)

    // 不信任前端报的大小，回读确认对象确实存在
    const buf = await this.storage.get(input.objectKey)
    if (!buf) {
      throw new NotFoundException(`对象不存在: ${input.objectKey}，直传可能未成功`)
    }
    this.storage.validate('zip', 'application/zip', buf.byteLength)

    const file = await this.prisma.projectFile.create({
      data: {
        projectId,
        kind: 'KICAD_ZIP',
        filename: input.filename,
        objectKey: input.objectKey,
        mimeType: 'application/zip',
        sizeBytes: buf.byteLength,
        parseStatus: 'PENDING',
      },
    })
    return this.handoff(projectId, file.id, input.objectKey)
  }

  /**
   * base64 直接上传。
   *
   * @deprecated 大文件请用 presign + complete。整个文件会在内存里过一遍，
   * 100MB 的 zip 会让 Node 峰值内存翻倍。保留是为了 mock 存储与本地开发。
   */
  async uploadAndParse(
    projectId: string,
    input: { filename: string; base64: string; mimeType?: string },
  ): Promise<UploadHandoff> {
    await this.assertProject(projectId)

    const data = Buffer.from(input.base64, 'base64')
    this.storage.validate('zip', input.mimeType ?? 'application/zip', data.byteLength)

    const key = this.storage.key(projectId, 'kicad', input.filename)
    const { objectKey, checksum } = await this.storage.put(key, data, 'application/zip')

    const file = await this.prisma.projectFile.create({
      data: {
        projectId,
        kind: 'KICAD_ZIP',
        filename: input.filename,
        objectKey,
        mimeType: 'application/zip',
        sizeBytes: data.byteLength,
        checksum,
        parseStatus: 'PENDING',
      },
    })
    return this.handoff(projectId, file.id, objectKey)
  }

  /** 重新解析已上传的工程 */
  async reparse(projectId: string, fileId: string): Promise<UploadHandoff> {
    const file = await this.prisma.projectFile.findUnique({ where: { id: fileId } })
    if (!file || file.projectId !== projectId) {
      throw new NotFoundException(`上传记录不存在: ${fileId}`)
    }
    await this.prisma.projectFile.update({
      where: { id: fileId },
      data: { parseStatus: 'PENDING', parseLog: null },
    })
    return this.handoff(projectId, fileId, file.objectKey)
  }

  private async handoff(
    projectId: string,
    fileId: string,
    objectKey: string,
  ): Promise<UploadHandoff> {
    await this.prisma.project.update({ where: { id: projectId }, data: { status: 'PARSING' } })

    const enq = await this.queue.enqueue('kicad.parse', { projectId, objectKey, fileId })
    if (enq.enqueued) {
      return {
        fileId,
        objectKey,
        status: 'QUEUED',
        degraded: false,
        jobId: enq.jobId,
        message: '已入队，解析完成后项目状态会更新',
      }
    }

    // 队列不可用：同步兜底。本地开发与无 Redis 的演示环境走这条路。
    this.logger.warn(`队列不可用（${enq.reason}），改为同步解析`)
    const outcome = await parseKicadArchive({
      projectId,
      objectKey,
      prisma: this.prisma,
      storage: this.storage.raw(),
    })

    await this.prisma.projectFile.update({
      where: { id: fileId },
      data: { parseStatus: outcome.status, parseLog: outcome.log },
    })
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: outcome.status === 'READY' ? 'READY' : 'ERROR' },
    })

    return {
      fileId,
      objectKey,
      status: outcome.status,
      degraded: true,
      jobId: null,
      message: `队列不可用，已同步解析：${outcome.components} 组件 / ${outcome.nets} 网络`,
    }
  }

  /** 解析状态与 parseLog，前端据此显示失败原因而不是空白页 */
  async status(projectId: string) {
    const [project, uploads, artifacts] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { status: true, designVersion: true },
      }),
      this.prisma.projectFile.findMany({
        where: { projectId, kind: 'KICAD_ZIP' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.projectFile.findMany({
        where: {
          projectId,
          kind: { in: ['SCHEMATIC', 'PCB', 'NETLIST', 'ERC_REPORT', 'DRC_REPORT'] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    return {
      status: project?.status ?? 'CREATED',
      designVersion: project?.designVersion ?? 1,
      queueAvailable: this.queue.available,
      uploads: uploads.map((f) => ({
        id: f.id,
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        parseStatus: f.parseStatus,
        parseLog: f.parseLog,
        createdAt: f.createdAt.toISOString(),
      })),
      artifacts: artifacts.map((f) => ({
        id: f.id,
        kind: f.kind,
        filename: f.filename,
        objectKey: f.objectKey,
        sizeBytes: f.sizeBytes,
      })),
    }
  }

  /** 产物下载：签名 URL 或直接回内容 */
  async artifactUrl(fileId: string): Promise<{ url: string | null; filename: string }> {
    const f = await this.prisma.projectFile.findUnique({ where: { id: fileId } })
    if (!f) throw new NotFoundException(`产物不存在: ${fileId}`)
    return { url: await this.storage.signedReadUrl(f.objectKey), filename: f.filename }
  }

  private async assertProject(id: string) {
    const p = await this.prisma.project.findUnique({ where: { id } })
    if (!p) throw new NotFoundException(`项目不存在: ${id}`)
    return p
  }
}
