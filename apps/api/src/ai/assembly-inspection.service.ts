import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { assemblyPromptTable, parsePcbAssembly, pickRoot, safeUnzip } from '@app/kicad'
import { createProvider, extractJson } from '@app/ai'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const ItemSchema = z.object({
  ref: z.string().min(1),
  value: z.string().default(''),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(240),
})

const AssemblyResultSchema = z.object({
  missing: z.array(ItemSchema).max(20).default([]),
  uncertain: z.array(ItemSchema).max(20).default([]),
  summary: z.string().max(300).default(''),
})

export type AssemblyInspectionResult = z.infer<typeof AssemblyResultSchema> & {
  photoId: string
  pcbFile: string
  inspected: number
  excluded: number
}

@Injectable()
export class AssemblyInspectionService {
  private readonly logger = new Logger(AssemblyInspectionService.name)
  private readonly provider = createProvider()

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private async loadPcbSource(projectId: string) {
    const upload = await this.prisma.projectFile.findFirst({
      where: { projectId, kind: 'KICAD_ZIP' },
      orderBy: { createdAt: 'desc' },
    })
    if (!upload) throw new NotFoundException('当前项目没有 KiCad 工程 ZIP，请先上传工程文件')

    const zip = await this.storage.get(upload.objectKey)
    if (!zip) throw new NotFoundException('KiCad 工程 ZIP 在对象存储中不存在')

    const dir = await mkdtemp(join(tmpdir(), 'bdc-assembly-'))
    try {
      const unzipped = await safeUnzip(zip, dir)
      const pro = unzipped.files.find((f) => f.endsWith('.kicad_pro'))
      const pcb = pickRoot(unzipped.files, '.kicad_pcb', pro)
      if (!pcb) throw new NotFoundException('工程 ZIP 中没有找到 .kicad_pcb 文件')
      return { filename: pcb.split(/[/\\]/).pop() ?? pcb, text: await readFile(join(dir, pcb), 'utf8') }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async inspect(photoId: string): Promise<AssemblyInspectionResult> {
    const photo = await this.prisma.boardPhoto.findUnique({ where: { id: photoId } })
    if (!photo) throw new NotFoundException(`照片不存在: ${photoId}`)

    const [photoBuf, pcb] = await Promise.all([
      this.storage.get(photo.objectKey),
      this.loadPcbSource(photo.projectId),
    ])
    if (!photoBuf) throw new NotFoundException('PCB 实物照片文件不存在')

    const map = parsePcbAssembly(pcb.text)
    const side = String(photo.side || 'TOP').toUpperCase() === 'BOTTOM' ? 'back' : 'front'
    const table = assemblyPromptTable(map, side)
    if (!table.length) throw new NotFoundException(`KiCad PCB 中没有可用于 ${side === 'front' ? '正面' : '背面'}装配检查的 footprint`)

    const ext = photo.objectKey.toLowerCase().split('.').pop() ?? ''
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

    const prompt = [
      '任务：只检查“设计中应安装、但实物照片中没有安装”的器件。不要介绍板卡，不要分析电路功能。',
      '',
      '下面的 KiCad 数据来自真实 .kicad_pcb。每一行代表一个 footprint；padCount/padNumbers 明确了哪些焊盘属于同一个器件。',
      'x/y 是相对元器件范围归一化坐标。照片可能有透视、旋转或镜像；先用板框、安装孔、连接器、丝印和器件群建立对应关系。',
      '',
      '判定规则：',
      '1. 只有当某 footprint 的整组焊盘/焊盘区域清晰可见、但对应器件本体明显不存在时，才放入 missing。',
      '2. 遮挡、反光、景深不足、照片裁切、无法可靠配准时，放入 uncertain；绝对不要猜。',
      '3. 不要把测试点、安装孔、Pogo 接触焊盘当漏装；这些已在服务端排除。',
      '4. 一个 footprint = 一个器件。不要把同一个器件的多个 pad 当成多个漏装项。',
      '5. 输出必须非常简洁；evidence 只写直接视觉证据。',
      '',
      `KiCad placements (${side}):`,
      JSON.stringify(table),
      '',
      '严格返回 JSON：{"missing":[{"ref":"J2","value":"SMA","confidence":0.98,"evidence":"SMA 整组焊盘清晰可见但无连接器本体"}],"uncertain":[],"summary":"确认未安装：J2。"}',
    ].join('\n')

    let parsed: z.infer<typeof AssemblyResultSchema> = { missing: [], uncertain: [], summary: '' }
    if (this.provider.name !== 'mock') {
      try {
        const raw = await this.provider.vision(
          [{ data: photoBuf.toString('base64'), mimeType }],
          prompt,
          { json: true },
        )
        const result = AssemblyResultSchema.safeParse(extractJson(raw))
        if (result.success) parsed = result.data
        else this.logger.warn(`assembly_inspect schema 失败: ${result.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      } catch (err) {
        this.logger.warn(`assembly_inspect 降级: ${(err as Error).message}`)
      }
    }

    const valid = new Map(table.map((x) => [x.ref, x]))
    const clean = (items: z.infer<typeof ItemSchema>[], min: number) => items
      .filter((x) => valid.has(x.ref) && x.confidence >= min)
      .map((x) => ({ ...x, value: x.value || valid.get(x.ref)?.value || '' }))

    const missing = clean(parsed.missing, 0.86)
    const missingRefs = new Set(missing.map((x) => x.ref))
    const uncertain = clean(parsed.uncertain, 0.55).filter((x) => !missingRefs.has(x.ref))
    const summary = missing.length
      ? `确认未安装：${missing.map((x) => x.ref).join('、')}。`
      : uncertain.length
        ? '没有确认的漏装器件；存在需要复拍确认的位置。'
        : '未发现确认的漏装器件。'

    return {
      photoId,
      pcbFile: pcb.filename,
      inspected: table.length,
      excluded: map.footprints.length - map.inspectable.length,
      missing,
      uncertain,
      summary,
    }
  }
}
