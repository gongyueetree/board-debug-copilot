import { Injectable, NotFoundException } from '@nestjs/common'
import type {
  BoardPhoto,
  CaptureSummary,
  DebugPlan,
  DesignBundle,
  Finding,
  ProjectDetail,
  ProjectSummary,
  Report,
  Scenario,
  VisualFinding,
} from '@app/contracts'
import { PrismaService } from '../prisma/prisma.service'

type Json = Record<string, unknown>

const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const iso = (d: Date) => d.toISOString()

/** 视觉发现的 certainty 由置信度推导（docs/05 §8.3：<0.6 不得标 CONFIRMED） */
const certaintyOf = (confidence: number, severity: string): 'CONFIRMED' | 'SUSPECTED' =>
  confidence >= 0.95 && severity === '正常' ? 'CONFIRMED' : 'SUSPECTED'

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ProjectSummary[]> {
    const rows = await this.prisma.project.findMany({ orderBy: { createdAt: 'desc' } })
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      currentIssue: p.currentIssue,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
    }))
  }

  async detail(id: string): Promise<ProjectDetail> {
    const p = await this.prisma.project.findUnique({ where: { id } })
    if (!p) throw new NotFoundException(`项目不存在: ${id}`)

    const [components, nets, testPoints, captures, photos, violations, steps, diagnoses] =
      await Promise.all([
        this.prisma.component.count({ where: { projectId: id } }),
        this.prisma.net.count({ where: { projectId: id } }),
        this.prisma.testPoint.count({ where: { projectId: id } }),
        this.prisma.capture.count({ where: { projectId: id } }),
        this.prisma.boardPhoto.count({ where: { projectId: id } }),
        this.prisma.ruleViolation.findMany({
          where: { projectId: id },
          select: { severity: true, resolved: true, origin: true, recommendedTest: true },
        }),
        this.prisma.debugStep.findMany({
          where: { projectId: id, parentId: { not: null } },
          select: { status: true },
        }),
        this.prisma.aiDiagnosis.findMany({
          where: { projectId: id },
          select: { recommendationsJson: true },
        }),
      ])

    const open = violations.filter((v) => !v.resolved)
    const bySeverity = { CRITICAL: 0, WARNING: 0, INFO: 0 }
    for (const v of open) bySeverity[v.severity] += 1

    // 「AI 建议」= 可执行的 AI 输出：诊断的推荐动作 + 带推荐测量的未解决 AI 发现
    const aiSuggestions =
      diagnoses.reduce(
        (n, d) => n + (Array.isArray(d.recommendationsJson) ? d.recommendationsJson.length : 0),
        0,
      ) + open.filter((v) => v.origin === 'AI' && v.recommendedTest).length

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      currentIssue: p.currentIssue,
      createdAt: iso(p.createdAt),
      updatedAt: iso(p.updatedAt),
      stats: {
        components,
        nets,
        testPoints,
        captures,
        photos,
        openViolations: open.length,
        totalViolations: violations.length,
        violationsBySeverity: bySeverity,
        debugSteps: {
          total: steps.length,
          completed: steps.filter((s) => s.status === 'COMPLETED').length,
        },
        aiSuggestions,
      },
    }
  }

  async design(id: string): Promise<DesignBundle> {
    await this.assertProject(id)

    const [components, nets, testPoints, violations] = await Promise.all([
      this.prisma.component.findMany({
        where: { projectId: id },
        orderBy: { ref: 'asc' },
        include: { pins: { include: { net: { select: { name: true } } }, orderBy: { number: 'asc' } } },
      }),
      this.prisma.net.findMany({
        where: { projectId: id },
        orderBy: { name: 'asc' },
        include: { _count: { select: { pins: true } } },
      }),
      this.prisma.testPoint.findMany({
        where: { projectId: id },
        orderBy: { label: 'asc' },
        include: { net: { select: { name: true } } },
      }),
      this.prisma.ruleViolation.findMany({
        where: { projectId: id },
        orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      }),
    ])

    const categories = new Map<string, number>()
    for (const c of components) {
      const cat = (asJson(c.rawJson).category as string | undefined) ?? '其他'
      categories.set(cat, (categories.get(cat) ?? 0) + 1)
    }

    const open = violations.filter((v) => !v.resolved)

    return {
      projectId: id,
      components: components.map((c) => ({
        id: c.id,
        ref: c.ref,
        value: c.value,
        footprint: c.footprint,
        partNumber: c.partNumber,
        manufacturer: c.manufacturer,
        datasheetUrl: c.datasheetUrl,
        category: (asJson(c.rawJson).category as string | undefined) ?? null,
        x: c.x,
        y: c.y,
        side: c.side,
        rawJson: c.rawJson,
        pins: c.pins.map((pin) => ({
          id: pin.id,
          number: pin.number,
          name: pin.name,
          type: pin.type,
          netName: pin.net?.name ?? null,
        })),
      })),
      nets: nets.map((n) => ({
        id: n.id,
        name: n.name,
        netClass: n.netClass,
        inferredRole: n.inferredRole,
        expectedVoltage: n.expectedVoltage,
        expectedFrequency: n.expectedFrequency,
        pinCount: n._count.pins,
      })),
      testPoints: testPoints.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        netName: t.net?.name ?? null,
        x: t.x,
        y: t.y,
        source: t.source,
      })),
      violations: violations.map((v) => this.toFinding(v)),
      categories: [...categories].map(([name, count]) => ({ name, count })),
      // 设计审查页权威值，全部来自数据本身。
      // 注意 docs/05 §16.2 #5：报告页效果图把总风险 12 误标成「ERC 错误 12」，不要照抄。
      ercDrc: {
        errors: open.filter((v) => v.origin === 'ERC' && v.severity === 'CRITICAL').length,
        warnings: open.filter((v) => v.origin === 'ERC' && v.severity !== 'CRITICAL').length,
        violations: open.filter((v) => v.origin === 'DRC').length,
      },
      bomRisk: {
        high: open.filter((v) => v.severity === 'CRITICAL').length,
        medium: open.filter((v) => v.severity === 'WARNING').length,
        low: open.filter((v) => v.severity === 'INFO').length,
        total: violations.length,
      },
    }
  }

  async captures(id: string): Promise<CaptureSummary[]> {
    await this.assertProject(id)
    const rows = await this.prisma.capture.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
      include: { net: { select: { name: true } } },
    })
    return rows.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      scenario: (asJson(c.hardwareSetupJson).scenario as Scenario | undefined) ?? null,
      netName: c.net?.name ?? null,
      debugStepId: c.debugStepId,
      measurements: c.measurementsJson as never,
      hardwareSetup: c.hardwareSetupJson,
      createdAt: iso(c.createdAt),
    }))
  }

  async plan(id: string): Promise<DebugPlan> {
    const project = await this.assertProject(id)
    const all = await this.prisma.debugStep.findMany({
      where: { projectId: id },
      orderBy: { order: 'asc' },
    })

    const groups = all.filter((s) => s.parentId === null)
    const leaves = all.filter((s) => s.parentId !== null)

    return {
      projectId: id,
      issue: project.currentIssue,
      goal: '快速定位导致输出无响应的根因并恢复正常输出',
      totalSteps: leaves.length,
      completedSteps: leaves.filter((s) => s.status === 'COMPLETED').length,
      groups: groups.map((g) => ({
        id: g.id,
        order: g.order,
        title: g.title,
        status: g.status,
        steps: leaves
          .filter((s) => s.parentId === g.id)
          .map((s) => ({
            id: s.id,
            order: s.order,
            number: `${g.order}.${s.order}`,
            title: s.title,
            objective: s.objective,
            toolHint: s.toolHint,
            estimateMin: s.estimateMin,
            setup: (s.setupJson as never) ?? null,
            targetNet: s.targetNet,
            targetComponent: s.targetComponent,
            expectedResult: s.expectedResult,
            abnormalNext: s.abnormalNext ? s.abnormalNext.split('\n').filter(Boolean) : [],
            status: s.status,
            result: s.resultJson ?? null,
          })),
      })),
    }
  }

  async photos(id: string): Promise<BoardPhoto[]> {
    await this.assertProject(id)
    const rows = await this.prisma.boardPhoto.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
      include: {
        visualFindings: { orderBy: { confidence: 'desc' } },
        annotations: { include: { component: { select: { ref: true } } } },
      },
    })

    return rows.map((p) => ({
      id: p.id,
      objectKey: p.objectKey,
      side: p.side,
      alignment: p.alignmentJson,
      createdAt: iso(p.createdAt),
      annotations: p.annotations.map((a) => ({
        id: a.id,
        kind: a.kind,
        region: a.regionJson as never,
        note: a.note,
        componentRef: a.component?.ref ?? null,
        createdBy: a.createdBy,
        createdAt: iso(a.createdAt),
      })),
      findings: p.visualFindings.map(
        (f): VisualFinding => ({
          id: f.id,
          code: f.code as VisualFinding['code'],
          title: f.title,
          detail: f.detail,
          confidence: f.confidence,
          severity: f.severity as VisualFinding['severity'],
          componentRef: f.componentRef,
          certainty: certaintyOf(f.confidence, f.severity),
        }),
      ),
    }))
  }

  async latestReport(id: string): Promise<Report> {
    await this.assertProject(id)
    const r = await this.prisma.debugReport.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
    })
    if (!r) throw new NotFoundException(`项目暂无报告: ${id}`)

    return {
      id: r.id,
      title: r.title,
      version: r.version,
      author: r.author,
      markdown: r.markdown,
      toc: (r.tocJson as never) ?? [],
      stats: (r.statsJson as never) ?? {
        issues: 0,
        resolved: 0,
        improvements: 0,
        measurements: 0,
        aiSuggestions: 0,
      },
      createdAt: iso(r.createdAt),
    }
  }

  private async assertProject(id: string) {
    const p = await this.prisma.project.findUnique({ where: { id } })
    if (!p) throw new NotFoundException(`项目不存在: ${id}`)
    return p
  }

  private toFinding(v: {
    id: string
    origin: string
    code: string
    severity: 'INFO' | 'WARNING' | 'CRITICAL'
    title: string
    description: string
    evidence: string | null
    risk: string | null
    suggestion: string | null
    recommendedTest: string | null
    componentRef: string | null
    netName: string | null
    resolved: boolean
  }): Finding {
    return {
      id: v.id,
      code: v.code as Finding['code'],
      origin: v.origin as Finding['origin'],
      severity: v.severity,
      title: v.title,
      description: v.description,
      evidence: v.evidence ? v.evidence.split('\n').filter(Boolean) : [v.description],
      risk: v.risk ?? '',
      suggestion: v.suggestion ?? '',
      recommendedTest: v.recommendedTest,
      componentRef: v.componentRef,
      netName: v.netName,
      resolved: v.resolved,
    }
  }
}
