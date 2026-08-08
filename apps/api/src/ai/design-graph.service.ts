import { Injectable, NotFoundException } from '@nestjs/common'
import type { DesignGraph, DigestInput } from '@app/kicad'
import { PrismaService } from '../prisma/prisma.service'

type Json = Record<string, unknown>
const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

/** 把数据库里的设计数据装配成规则引擎与 DesignDigest 需要的形状 */
@Injectable()
export class DesignGraphService {
  constructor(private readonly prisma: PrismaService) {}

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

    const graph: DesignGraph = {
      components: components.map((c) => ({
        ref: c.ref,
        value: c.value,
        category: (asJson(c.rawJson).category as string | undefined) ?? null,
        partNumber: c.partNumber,
        meta: asJson(c.rawJson),
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
