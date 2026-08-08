import { Injectable, NotFoundException } from '@nestjs/common'
import type { DesignGraph, DigestInput } from '@app/kicad'
import { PartsService } from '../parts/parts.service'
import { PrismaService } from '../prisma/prisma.service'

type Json = Record<string, unknown>
const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

/** 把数据库里的设计数据装配成规则引擎与 DesignDigest 需要的形状 */
@Injectable()
export class DesignGraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parts: PartsService,
  ) {}

  async build(projectId: string): Promise<DigestInput> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)

    const [components, nets, testPoints] = await Promise.all([
      this.prisma.component.findMany({
        where: { projectId },
        orderBy: { ref: 'asc' },
        include: { pins: { include: { net: { select: { name: true } } } } },
      }),
      this.prisma.net.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
        include: {
          pins: {
            include: { component: { select: { ref: true } } },
          },
        },
      }),
      this.prisma.testPoint.findMany({
        where: { projectId },
        orderBy: { label: 'asc' },
        include: { net: { select: { name: true } } },
      }),
    ])

    // 器件参数来自 PartsDatabaseAdapter，而不是硬编码在 seed 里 ——
    // 换真实百万器件库时这里是唯一的接入点（docs/00 §12）
    const knowledge = new Map<string, Record<string, unknown>>()
    await Promise.all(
      components
        .map((c) => c.partNumber ?? c.value)
        .filter((k): k is string => Boolean(k))
        .map(async (k) => {
          if (knowledge.has(k)) return
          const p = await this.parts.lookup(k)
          if (p) knowledge.set(k, { ...p.params, summary: p.summary, manufacturer: p.manufacturer })
        }),
    )

    const graph: DesignGraph = {
      components: components.map((c) => ({
        ref: c.ref,
        value: c.value,
        category: (asJson(c.rawJson).category as string | undefined) ?? null,
        partNumber: c.partNumber,
        // rawJson 优先：seed 里手写的参数覆盖器件库的通用值
        meta: { ...(knowledge.get(c.partNumber ?? c.value ?? '') ?? {}), ...asJson(c.rawJson) },
        pins: c.pins.map((p) => ({
          number: p.number,
          name: p.name,
          type: p.type,
          netName: p.net?.name ?? null,
        })),
      })),
      nets: nets.map((n) => ({
        name: n.name,
        inferredRole: n.inferredRole,
        expectedVoltage: n.expectedVoltage,
        pinRefs: n.pins.map((p) => ({
          componentRef: p.component.ref,
          pinNumber: p.number,
          pinName: p.name,
        })),
      })),
    }

    return {
      projectName: project.name,
      currentIssue: project.currentIssue,
      graph,
      testPoints: testPoints.map((t) => ({ label: t.label, netName: t.net?.name ?? null })),
    }
  }
}
