import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { z } from 'zod'
import {
  assemblyPromptTable,
  computeHomography,
  generateFootprintRois,
  parsePcbAssembly,
  projectPoint,
  type Point2D,
} from '@app/kicad'
import { createProvider, extractJson } from '@app/ai'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { AssemblySourceService } from './assembly-source.service'

const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
const RegistrationSchema = z.object({
  pcb00: PointSchema,
  pcb10: PointSchema,
  pcb11: PointSchema,
  pcb01: PointSchema,
  confidence: z.number().min(0).max(1),
  anchors: z.array(z.object({ ref: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), confidence: z.number().min(0).max(1) })).max(12).default([]),
  evidence: z.string().max(400).default(''),
})

export interface AssemblyAlignmentResult {
  photoId: string
  pcbFile: string
  side: 'front' | 'back'
  status: 'aligned' | 'low-confidence' | 'unavailable'
  confidence: number
  validationError: number | null
  boundsSource: 'edge-cuts' | 'footprints'
  corners: { pcb00: Point2D; pcb10: Point2D; pcb11: Point2D; pcb01: Point2D } | null
  anchors: { ref: string; x: number; y: number; confidence: number }[]
  rois: { ref: string; value: string; x: number; y: number; w: number; h: number; polygon: Point2D[]; center: Point2D }[]
}

@Injectable()
export class AssemblyAlignmentService {
  private readonly logger = new Logger(AssemblyAlignmentService.name)
  private readonly provider = createProvider()

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly source: AssemblySourceService,
  ) {}

  async align(photoId: string, force = false): Promise<AssemblyAlignmentResult> {
    const photo = await this.prisma.boardPhoto.findUnique({ where: { id: photoId } })
    if (!photo) throw new NotFoundException(`照片不存在: ${photoId}`)

    if (!force && photo.alignmentJson) {
      const cached = photo.alignmentJson as unknown as AssemblyAlignmentResult
      if (cached?.photoId === photoId && Array.isArray(cached?.rois) && cached.rois.length > 0) return cached
    }

    const [{ filename, text }, photoBuf] = await Promise.all([
      this.source.loadPcb(photo.projectId),
      this.storage.get(photo.objectKey),
    ])
    if (!photoBuf) throw new NotFoundException('PCB 实物照片文件不存在')

    const map = parsePcbAssembly(text)
    const side: 'front' | 'back' = String(photo.side || 'TOP').toUpperCase() === 'BOTTOM' ? 'back' : 'front'
    const candidates = map.inspectable.filter((f) => f.side === side)
    if (!candidates.length) throw new NotFoundException(`KiCad PCB 中没有 ${side === 'front' ? '正面' : '背面'}可检查 footprint`)

    if (this.provider.name === 'mock') {
      return this.persist(photoId, {
        photoId, pcbFile: filename, side, status: 'unavailable', confidence: 0, validationError: null,
        boundsSource: map.boundsSource, corners: null, anchors: [], rois: [],
      })
    }

    const ext = photo.objectKey.toLowerCase().split('.').pop() ?? ''
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const placements = assemblyPromptTable(map, side).slice(0, 100)
    const prompt = [
      '你在做 PCB 实物照片与 KiCad PCB 坐标的自动配准。只做几何定位，不做故障分析。',
      '',
      'KiCad 板框坐标定义：pcb00=(minX,minY), pcb10=(maxX,minY), pcb11=(maxX,maxY), pcb01=(minX,maxY)。',
      '请在实物照片中找到这四个“物理板角”对应的归一化图像坐标 x/y（左上图像坐标为 0,0，右下为 1,1）。',
      '注意：板子在照片里可能任意旋转、透视；背面照片会视觉镜像。不要按图像左上/右上机械赋值，必须利用器件位号、连接器、安装孔和器件群判断哪个物理角对应哪个 KiCad 角。',
      '同时尽量识别 4~12 个可确定的位号中心作为 anchors，用于服务端验证配准。无法确认的位号不要输出。',
      '',
      `当前照片面：${side}`,
      `KiCad bounds source: ${map.boundsSource}`,
      '可检查 footprint 的归一化 KiCad 位置：',
      JSON.stringify(placements),
      '',
      '严格只返回 JSON：',
      '{"pcb00":{"x":0.1,"y":0.1},"pcb10":{"x":0.9,"y":0.12},"pcb11":{"x":0.88,"y":0.9},"pcb01":{"x":0.12,"y":0.88},"confidence":0.92,"anchors":[{"ref":"U1","x":0.52,"y":0.46,"confidence":0.95}],"evidence":"根据板框、J1、U1 和安装孔定位"}',
    ].join('\n')

    let reg: z.infer<typeof RegistrationSchema>
    try {
      const raw = await this.provider.vision([{ data: photoBuf.toString('base64'), mimeType }], prompt, { json: true })
      const parsed = RegistrationSchema.safeParse(extractJson(raw))
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      reg = parsed.data
    } catch (err) {
      this.logger.warn(`assembly_align failed: ${(err as Error).message}`)
      return this.persist(photoId, {
        photoId, pcbFile: filename, side, status: 'unavailable', confidence: 0, validationError: null,
        boundsSource: map.boundsSource, corners: null, anchors: [], rois: [],
      })
    }

    const b = map.bounds
    const src = [
      { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
    ]
    const dst = [reg.pcb00, reg.pcb10, reg.pcb11, reg.pcb01]
    const H = computeHomography(src, dst)

    const fpByRef = new Map(candidates.map((f) => [f.ref, f]))
    const anchorErrors: number[] = []
    for (const a of reg.anchors) {
      const fp = fpByRef.get(a.ref)
      if (!fp || a.confidence < 0.6) continue
      const p = projectPoint(H, { x: fp.x, y: fp.y })
      anchorErrors.push(Math.hypot(p.x - a.x, p.y - a.y))
    }
    const validationError = anchorErrors.length ? Math.sqrt(anchorErrors.reduce((s, e) => s + e * e, 0) / anchorErrors.length) : null
    const validationFactor = validationError == null ? 0.86 : Math.max(0.15, Math.min(1, 1 - validationError / 0.12))
    const confidence = Number((reg.confidence * validationFactor).toFixed(3))

    const roiGeom = generateFootprintRois(candidates.map((f) => ({ ref: f.ref, x: f.x, y: f.y, pads: f.pads })), H)
    const values = new Map(candidates.map((f) => [f.ref, f.value]))
    const rois = roiGeom
      .filter((r) => r.w > 0.002 && r.h > 0.002)
      .map((r) => ({ ...r, value: values.get(r.ref) ?? '' }))

    const result: AssemblyAlignmentResult = {
      photoId, pcbFile: filename, side,
      status: confidence >= 0.68 ? 'aligned' : 'low-confidence',
      confidence, validationError: validationError == null ? null : Number(validationError.toFixed(4)),
      boundsSource: map.boundsSource,
      corners: { pcb00: reg.pcb00, pcb10: reg.pcb10, pcb11: reg.pcb11, pcb01: reg.pcb01 },
      anchors: reg.anchors,
      rois,
    }
    return this.persist(photoId, result)
  }

  private async persist(photoId: string, result: AssemblyAlignmentResult) {
    await this.prisma.boardPhoto.update({ where: { id: photoId }, data: { alignmentJson: result as never } })
    return result
  }
}
