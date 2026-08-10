import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { StepStatus } from '@app/contracts'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

type Json = Record<string, unknown>
const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

/** 所有写操作。读操作在 ProjectsService。 */
@Injectable()
export class MutationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------- 照片

  async uploadPhoto(
    projectId: string,
    input: { filename: string; mimeType: string; base64: string; side?: string },
  ) {
    await this.assertProject(projectId)

    const data = Buffer.from(input.base64, 'base64')
    this.storage.validate('photo', input.mimeType, data.byteLength)

    // 用户文件名不直接拼进 key：sanitize + uuid 前缀在 @app/storage 里统一处理
    const key = this.storage.key(projectId, 'photos', input.filename)
    const { objectKey, checksum } = await this.storage.put(key, data, input.mimeType)

    const [photo] = await this.prisma.$transaction([
      this.prisma.boardPhoto.create({
        data: { projectId, objectKey, side: input.side ?? 'TOP' },
      }),
      this.prisma.projectFile.create({
        data: {
          projectId,
          kind: 'PCB_PHOTO',
          filename: input.filename,
          objectKey,
          mimeType: input.mimeType,
          sizeBytes: data.byteLength,
          checksum,
          parseStatus: 'OK',
        },
      }),
    ])

    return { id: photo.id, objectKey, sizeBytes: data.byteLength }
  }

  async createAnnotation(
    photoId: string,
    input: {
      kind: string
      region: { x: number; y: number; w: number; h: number }
      note?: string
      componentRef?: string
      createdBy?: string
    },
  ) {
    const photo = await this.prisma.boardPhoto.findUnique({ where: { id: photoId } })
    if (!photo) throw new NotFoundException(`照片不存在: ${photoId}`)

    // 关联到组件必须是本项目真实存在的位号
    let componentId: string | null = null
    if (input.componentRef) {
      const c = await this.prisma.component.findFirst({
        where: { projectId: photo.projectId, ref: input.componentRef },
      })
      if (!c) throw new BadRequestException(`位号不存在于本项目: ${input.componentRef}`)
      componentId = c.id
    }

    const a = await this.prisma.photoAnnotation.create({
      data: {
        photoId,
        componentId,
        kind: input.kind,
        regionJson: input.region as never,
        note: input.note ?? null,
        createdBy: input.createdBy ?? 'USER',
      },
    })
    return { id: a.id }
  }

  async deleteAnnotation(id: string) {
    await this.prisma.photoAnnotation.delete({ where: { id } })
    return { deleted: true }
  }

  // ---------------------------------------------------------------- 捕获

  async saveCapture(
    projectId: string,
    input: {
      label?: string
      kind?: 'OSCILLOSCOPE' | 'FFT' | 'BODE' | 'LOGIC' | 'DMM' | 'POWER'
      netName?: string
      debugStepId?: string
      hardwareSetup: Json
      measurements: Json
      /** 原始波形数组，只进对象存储，绝不入库（硬性原则 #4） */
      waveform?: { ch1: number[]; ch2: number[]; fs: number }
    },
  ) {
    await this.assertProject(projectId)

    let waveformObjectKey: string | null = null
    if (input.waveform) {
      const key = this.storage.key(projectId, 'waveforms', 'waveform.json')
      const { objectKey } = await this.storage.put(
        key,
        Buffer.from(JSON.stringify(input.waveform)),
        'application/json',
      )
      waveformObjectKey = objectKey
    }

    const net = input.netName
      ? await this.prisma.net.findFirst({ where: { projectId, name: input.netName } })
      : null

    const c = await this.prisma.capture.create({
      data: {
        projectId,
        netId: net?.id ?? null,
        kind: input.kind ?? 'OSCILLOSCOPE',
        label: input.label ?? null,
        debugStepId: input.debugStepId ?? null,
        hardwareSetupJson: input.hardwareSetup as never,
        measurementsJson: input.measurements as never,
        waveformObjectKey,
      },
    })
    return { id: c.id, waveformObjectKey }
  }

  // ---------------------------------------------------------------- 调试步骤

  async updateStep(
    stepId: string,
    input: { status?: StepStatus; result?: Json; objective?: string; expectedResult?: string },
  ) {
    const step = await this.prisma.debugStep.findUnique({ where: { id: stepId } })
    if (!step) throw new NotFoundException(`步骤不存在: ${stepId}`)

    const merged = input.result
      ? { ...asJson(step.resultJson), ...input.result }
      : (step.resultJson ?? undefined)

    const updated = await this.prisma.debugStep.update({
      where: { id: stepId },
      data: {
        status: input.status ?? step.status,
        resultJson: merged as never,
        objective: input.objective ?? step.objective,
        expectedResult: input.expectedResult ?? step.expectedResult,
      },
    })

    // 分组状态由子步骤推导，不单独维护
    if (step.parentId) await this.syncGroupStatus(step.parentId)

    return { id: updated.id, status: updated.status }
  }

  private async syncGroupStatus(groupId: string) {
    const children = await this.prisma.debugStep.findMany({
      where: { parentId: groupId },
      select: { status: true },
    })
    const status = children.every((c) => c.status === 'COMPLETED')
      ? 'COMPLETED'
      : children.some((c) => c.status !== 'PENDING')
        ? 'IN_PROGRESS'
        : 'PENDING'
    await this.prisma.debugStep.update({ where: { id: groupId }, data: { status } })
  }

  async createCustomStep(
    projectId: string,
    input: { groupId?: string; title: string; objective?: string; toolHint?: string; estimateMin?: number },
  ) {
    await this.assertProject(projectId)

    let parentId = input.groupId ?? null
    if (!parentId) {
      const custom = await this.prisma.debugStep.findFirst({
        where: { projectId, parentId: null, title: '自定义步骤' },
      })
      parentId =
        custom?.id ??
        (
          await this.prisma.debugStep.create({
            data: {
              projectId,
              order: 99,
              title: '自定义步骤',
              status: 'PENDING',
            },
          })
        ).id
    }

    const siblings = await this.prisma.debugStep.count({ where: { parentId } })
    const s = await this.prisma.debugStep.create({
      data: {
        projectId,
        parentId,
        order: siblings + 1,
        title: input.title,
        objective: input.objective ?? null,
        toolHint: input.toolHint ?? '万用表',
        estimateMin: input.estimateMin ?? 2,
        status: 'PENDING',
      },
    })
    return { id: s.id }
  }

  /** 标注与照片的归属查询，供 controller 鉴权用 */
  async projectIdForPhoto(photoId: string): Promise<string> {
    const p = await this.prisma.boardPhoto.findUnique({
      where: { id: photoId },
      select: { projectId: true },
    })
    if (!p) throw new NotFoundException(`照片不存在: ${photoId}`)
    return p.projectId
  }

  async projectIdForStep(stepId: string): Promise<string> {
    const s = await this.prisma.debugStep.findUnique({
      where: { id: stepId },
      select: { projectId: true },
    })
    if (!s) throw new NotFoundException(`步骤不存在: ${stepId}`)
    return s.projectId
  }

  async projectIdForAnnotation(id: string): Promise<string> {
    const a = await this.prisma.photoAnnotation.findUnique({
      where: { id },
      select: { photo: { select: { projectId: true } } },
    })
    if (!a) throw new NotFoundException(`标注不存在: ${id}`)
    return a.photo.projectId
  }

  private async assertProject(id: string) {
    const p = await this.prisma.project.findUnique({ where: { id } })
    if (!p) throw new NotFoundException(`项目不存在: ${id}`)
    return p
  }
}
