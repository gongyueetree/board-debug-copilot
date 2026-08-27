import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { assemblyPromptTable, parsePcbAssembly } from '@app/kicad'
import { createProvider, extractJson } from '@app/ai'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { AssemblySourceService } from './assembly-source.service'
import { AssemblyAlignmentService, type AssemblyAlignmentResult } from './assembly-alignment.service'

const ItemSchema = z.object({
  ref: z.string().min(1),
  value: z.string().default(''),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(240),
})

const BatchResultSchema = z.object({
  missing: z.array(ItemSchema).max(20).default([]),
  uncertain: z.array(ItemSchema).max(20).default([]),
})

export type AssemblyInspectionResult = {
  photoId: string
  pcbFile: string
  inspected: number
  excluded: number
  missing: z.infer<typeof ItemSchema>[]
  uncertain: z.infer<typeof ItemSchema>[]
  summary: string
  alignment: Pick<AssemblyAlignmentResult, 'status' | 'confidence' | 'validationError' | 'boundsSource' | 'corners' | 'anchors'>
  rois: AssemblyAlignmentResult['rois']
}

@Injectable()
export class AssemblyInspectionService {
  private readonly logger = new Logger(AssemblyInspectionService.name)
  private readonly provider = createProvider()

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly source: AssemblySourceService,
    private readonly alignmentService: AssemblyAlignmentService,
  ) {}

  async inspect(photoId: string): Promise<AssemblyInspectionResult> {
    const photo = await this.prisma.boardPhoto.findUnique({ where: { id: photoId } })
    if (!photo) throw new NotFoundException(`照片不存在: ${photoId}`)

    const [{ filename, text }, photoBuf, alignment] = await Promise.all([
      this.source.loadPcb(photo.projectId),
      this.storage.get(photo.objectKey),
      this.alignmentService.align(photoId),
    ])
    if (!photoBuf) throw new NotFoundException('PCB 实物照片文件不存在')

    const map = parsePcbAssembly(text)
    const side = String(photo.side || 'TOP').toUpperCase() === 'BOTTOM' ? 'back' : 'front'
    const table = assemblyPromptTable(map, side)
    if (!table.length) throw new NotFoundException(`KiCad PCB 中没有可用于 ${side === 'front' ? '正面' : '背面'}装配检查的 footprint`)

    if (alignment.status !== 'aligned' || alignment.confidence < 0.68) {
      return {
        photoId,
        pcbFile: filename,
        inspected: 0,
        excluded: map.footprints.length - map.inspectable.length,
        missing: [],
        uncertain: [],
        summary: `自动配准置信度不足（${Math.round(alignment.confidence * 100)}%），请把整块 PCB 和板边拍清楚后重试。`,
        alignment: this.alignmentMeta(alignment),
        rois: alignment.rois,
      }
    }

    const roiByRef = new Map(alignment.rois.map((r) => [r.ref, r]))
    const inspectRows = table
      .map((f) => ({ ...f, roi: roiByRef.get(f.ref) }))
      .filter((f) => f.roi && f.roi.w >= 0.003 && f.roi.h >= 0.003)

    const ext = photo.objectKey.toLowerCase().split('.').pop() ?? ''
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const missingAll: z.infer<typeof ItemSchema>[] = []
    const uncertainAll: z.infer<typeof ItemSchema>[] = []

    if (this.provider.name !== 'mock') {
      for (let offset = 0; offset < inspectRows.length; offset += 45) {
        const batch = inspectRows.slice(offset, offset + 45)
        const prompt = [
          '任务：PCB 装配漏件检查。只判断给定 ROI 内“设计应安装但实物没有安装”的器件。不要介绍板卡，不要分析电路。',
          '',
          '服务端已经把 KiCad PCB 与照片做了透视配准。每一行的 roi 是该 footprint 在照片中的归一化区域 x/y/w/h；同一 footprint 的全部 pads 属于同一个器件。',
          '请严格按 roi 定位，不要再自行猜位号位置。',
          '',
          '判定规则：',
          '1. ROI 内清楚看到对应器件本体 → 不输出。',
          '2. ROI 内整组焊盘/焊盘区域清楚可见且器件本体明显不存在 → missing。',
          '3. ROI 被遮挡、反光、虚焦、裁切，或器件太小无法确认 → uncertain。',
          '4. 一个 footprint 只允许一个结果；不要把多个 pad 当多个器件。',
          '5. missing 必须高置信，宁可 uncertain 也不要猜。evidence 只写一句直接视觉证据。',
          '',
          `自动配准置信度：${alignment.confidence}`,
          '本批 footprint + ROI：',
          JSON.stringify(batch),
          '',
          '严格只返回 JSON：{"missing":[{"ref":"J2","value":"SMA","confidence":0.98,"evidence":"ROI 内 SMA 焊盘组完整可见但无连接器本体"}],"uncertain":[]}',
        ].join('\n')

        try {
          const raw = await this.provider.vision([{ data: photoBuf.toString('base64'), mimeType }], prompt, { json: true })
          const parsed = BatchResultSchema.safeParse(extractJson(raw))
          if (parsed.success) {
            missingAll.push(...parsed.data.missing)
            uncertainAll.push(...parsed.data.uncertain)
          } else {
            this.logger.warn(`assembly batch ${offset / 45 + 1} schema 失败: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
          }
        } catch (err) {
          this.logger.warn(`assembly batch ${offset / 45 + 1} 降级: ${(err as Error).message}`)
        }
      }
    }

    const valid = new Map(inspectRows.map((x) => [x.ref, x]))
    const dedupe = (items: z.infer<typeof ItemSchema>[], min: number) => {
      const best = new Map<string, z.infer<typeof ItemSchema>>()
      for (const x of items) {
        if (!valid.has(x.ref) || x.confidence < min) continue
        const row = valid.get(x.ref)!
        const item = { ...x, value: x.value || row.value || '' }
        if (!best.has(x.ref) || best.get(x.ref)!.confidence < x.confidence) best.set(x.ref, item)
      }
      return [...best.values()].sort((a, b) => b.confidence - a.confidence)
    }

    const missing = dedupe(missingAll, 0.88)
    const missingRefs = new Set(missing.map((x) => x.ref))
    const uncertain = dedupe(uncertainAll, 0.55).filter((x) => !missingRefs.has(x.ref))
    const summary = missing.length
      ? `确认未安装：${missing.map((x) => x.ref).join('、')}。`
      : uncertain.length
        ? '未发现确认的漏装器件；存在需要复拍确认的位置。'
        : '未发现确认的漏装器件。'

    return {
      photoId,
      pcbFile: filename,
      inspected: inspectRows.length,
      excluded: map.footprints.length - map.inspectable.length,
      missing,
      uncertain,
      summary,
      alignment: this.alignmentMeta(alignment),
      rois: alignment.rois,
    }
  }

  private alignmentMeta(a: AssemblyAlignmentResult) {
    return {
      status: a.status,
      confidence: a.confidence,
      validationError: a.validationError,
      boundsSource: a.boundsSource,
      corners: a.corners,
      anchors: a.anchors,
    }
  }
}
