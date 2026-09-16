import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

type JsonRecord = Record<string, unknown>

type EvidenceInput = {
  kind: 'IMAGE' | 'MEASUREMENT' | 'WAVEFORM' | 'KICAD' | 'VOICE' | 'SESSION' | 'INSTRUMENT' | 'DIAGNOSIS' | 'TEST_RESULT'
  ref: string
  sourceType: string
  sourceId?: string
  componentId?: string
  pinId?: string
  netId?: string
  testPointId?: string
  debugStepId?: string
  excerpt?: string
  data?: JsonRecord
}

type ComparableEvidence = {
  kind: string
  ref: string
  sourceType: string
  componentId: string | null
  pinId: string | null
  netId: string | null
  testPointId: string | null
  debugStepId: string | null
  dataJson: unknown
}

const evidenceKindForSuggestion = (kind: string) => {
  const map: Record<string, string> = {
    IMAGE: 'image',
    MEASUREMENT: 'measurement',
    WAVEFORM: 'waveform',
    KICAD: 'kicad',
    VOICE: 'voice',
    SESSION: 'session',
    INSTRUMENT: 'instrument',
    DIAGNOSIS: 'session',
    TEST_RESULT: 'measurement',
  }
  return map[kind] ?? 'session'
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const measurementValue = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null
  const data = value as JsonRecord
  const direct = finiteNumber(data.value)
  if (direct !== null) return direct
  for (const key of ['voltage', 'frequency', 'vpp', 'rms', 'mean', 'period', 'duty']) {
    const candidate = finiteNumber(data[key])
    if (candidate !== null) return candidate
  }
  const measurements = data.measurements
  if (measurements && typeof measurements === 'object') return measurementValue(measurements)
  return null
}

const textRelevance = (text: string, values: Array<string | null | undefined>) => {
  const haystack = text.toLowerCase()
  const hits = values.filter((v) => v && haystack.includes(v.toLowerCase())).length
  return Math.min(1, 0.45 + hits * 0.25)
}

/**
 * Golden Board evidence must be paired by engineering identity, not by capture/photo UUID.
 * Board A and Board B never share a source object id, but they do share Net/Pin/TestPoint/Ref semantics.
 */
const evidenceComparisonKey = (item: ComparableEvidence) => {
  if (item.pinId) return `${item.kind}:pin:${item.pinId}`
  if (item.testPointId) return `${item.kind}:test-point:${item.testPointId}`
  if (item.netId) return `${item.kind}:net:${item.netId}`
  if (item.componentId) return `${item.kind}:component:${item.componentId}`
  if (item.debugStepId) return `${item.kind}:test-step:${item.debugStepId}`

  const data = item.dataJson && typeof item.dataJson === 'object' ? item.dataJson as JsonRecord : {}
  const targetNet = typeof data.targetNet === 'string' ? data.targetNet : null
  const targetComponent = typeof data.targetComponent === 'string' ? data.targetComponent : null
  const side = typeof data.side === 'string' ? data.side : null
  const channel = typeof data.channel === 'string' ? data.channel : null
  if (targetNet) return `${item.kind}:net-name:${targetNet}`
  if (targetComponent) return `${item.kind}:ref:${targetComponent}`
  if (item.kind === 'IMAGE' && side) return `${item.kind}:board:${side}`
  if (channel) return `${item.kind}:channel:${channel}`

  // Explicit caller-provided refs remain the final stable key. Source IDs are intentionally ignored.
  return `${item.kind}:ref:${item.ref}`
}

@Injectable()
export class LabSightWorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  private async project(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)
    return project
  }

  async projectIdForSession(sessionId: string) {
    const session = await this.prisma.debugSession.findUnique({ where: { id: sessionId }, select: { projectId: true } })
    if (!session) throw new NotFoundException(`Debug Session 不存在: ${sessionId}`)
    return session.projectId
  }

  async projectIdForDraft(draftId: string) {
    const draft = await this.prisma.labSuggestionDraft.findUnique({ where: { id: draftId }, select: { projectId: true } })
    if (!draft) throw new NotFoundException(`LabSight 草稿不存在: ${draftId}`)
    return draft.projectId
  }

  async listBoards(projectId: string) {
    await this.project(projectId)
    return this.prisma.board.findMany({ where: { projectId }, orderBy: [{ isGolden: 'desc' }, { createdAt: 'desc' }] })
  }

  async createBoard(projectId: string, input: { serialNo?: string; batchNo?: string; label?: string; isGolden?: boolean }) {
    const project = await this.project(projectId)
    if (input.isGolden) {
      await this.prisma.board.updateMany({ where: { projectId, isGolden: true }, data: { isGolden: false } })
    }
    return this.prisma.board.create({
      data: {
        projectId,
        designVersion: project.designVersion,
        serialNo: input.serialNo,
        batchNo: input.batchNo,
        label: input.label,
        isGolden: input.isGolden ?? false,
      },
    })
  }

  async listSessions(projectId: string) {
    await this.project(projectId)
    return this.prisma.debugSession.findMany({
      where: { projectId },
      include: { board: true, _count: { select: { evidence: true, captures: true, hypotheses: true } } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createSession(projectId: string, input: { boardId?: string; title: string; issue?: string; goal?: string; ownerId?: string }) {
    const project = await this.project(projectId)
    if (input.boardId) {
      const board = await this.prisma.board.findFirst({ where: { id: input.boardId, projectId } })
      if (!board) throw new BadRequestException('boardId 不属于当前项目')
    }
    const session = await this.prisma.debugSession.create({
      data: {
        projectId,
        boardId: input.boardId,
        designVersion: project.designVersion,
        title: input.title,
        issue: input.issue ?? project.currentIssue,
        goal: input.goal,
        ownerId: input.ownerId,
      },
    })
    if (session.issue && session.issue !== project.currentIssue) {
      await this.prisma.project.update({ where: { id: projectId }, data: { currentIssue: session.issue } })
    }
    return session
  }

  async updateSession(
    sessionId: string,
    input: { title?: string; issue?: string; goal?: string; status?: 'OPEN' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'; rootCauseCode?: string },
  ) {
    const session = await this.prisma.debugSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundException(`Debug Session 不存在: ${sessionId}`)
    const data = {
      ...input,
      closedAt: input.status === 'COMPLETED' || input.status === 'CANCELLED' ? new Date() : undefined,
    }
    const updated = await this.prisma.debugSession.update({ where: { id: sessionId }, data })
    if (input.issue) {
      await this.prisma.project.update({ where: { id: session.projectId }, data: { currentIssue: input.issue } })
    }
    return updated
  }

  async listEvidence(sessionId: string) {
    await this.projectIdForSession(sessionId)
    return this.prisma.labEvidence.findMany({
      where: { sessionId },
      include: {
        component: { select: { ref: true } },
        pin: { select: { number: true, name: true } },
        net: { select: { name: true } },
        testPoint: { select: { label: true } },
        debugStep: { select: { title: true, order: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  private async validateEvidenceBinding(projectId: string, input: EvidenceInput) {
    if (input.componentId) {
      const c = await this.prisma.component.findFirst({ where: { id: input.componentId, projectId }, select: { id: true } })
      if (!c) throw new BadRequestException('componentId 不属于当前项目')
    }
    if (input.pinId) {
      const pin = await this.prisma.pin.findFirst({ where: { id: input.pinId, component: { projectId } }, select: { id: true } })
      if (!pin) throw new BadRequestException('pinId 不属于当前项目')
    }
    if (input.netId) {
      const net = await this.prisma.net.findFirst({ where: { id: input.netId, projectId }, select: { id: true } })
      if (!net) throw new BadRequestException('netId 不属于当前项目')
    }
    if (input.testPointId) {
      const tp = await this.prisma.testPoint.findFirst({ where: { id: input.testPointId, projectId }, select: { id: true } })
      if (!tp) throw new BadRequestException('testPointId 不属于当前项目')
    }
    if (input.debugStepId) {
      const step = await this.prisma.debugStep.findFirst({ where: { id: input.debugStepId, projectId }, select: { id: true } })
      if (!step) throw new BadRequestException('debugStepId 不属于当前项目')
    }
  }

  async addEvidence(sessionId: string, input: EvidenceInput) {
    const projectId = await this.projectIdForSession(sessionId)
    await this.validateEvidenceBinding(projectId, input)
    return this.prisma.labEvidence.upsert({
      where: { sessionId_ref: { sessionId, ref: input.ref } },
      create: {
        projectId,
        sessionId,
        kind: input.kind,
        ref: input.ref,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        componentId: input.componentId,
        pinId: input.pinId,
        netId: input.netId,
        testPointId: input.testPointId,
        debugStepId: input.debugStepId,
        excerpt: input.excerpt,
        dataJson: input.data as never,
      },
      update: {
        kind: input.kind,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        componentId: input.componentId,
        pinId: input.pinId,
        netId: input.netId,
        testPointId: input.testPointId,
        debugStepId: input.debugStepId,
        excerpt: input.excerpt,
        dataJson: input.data as never,
      },
    })
  }

  async bindCapture(sessionId: string, captureId: string, input: Omit<EvidenceInput, 'kind' | 'sourceType' | 'sourceId'>) {
    const projectId = await this.projectIdForSession(sessionId)
    const capture = await this.prisma.capture.findFirst({ where: { id: captureId, projectId } })
    if (!capture) throw new NotFoundException('Capture 不属于当前项目')
    await this.prisma.capture.update({ where: { id: captureId }, data: { sessionId } })
    return this.addEvidence(sessionId, {
      ...input,
      kind: capture.kind === 'OSCILLOSCOPE' ? 'WAVEFORM' : 'MEASUREMENT',
      sourceType: 'capture',
      sourceId: captureId,
      data: { ...(input.data ?? {}), measurements: capture.measurementsJson },
    })
  }

  async createDraft(projectId: string, kind: 'ISSUE' | 'ECO', input: { sessionId: string; payload: JsonRecord }) {
    const session = await this.prisma.debugSession.findFirst({ where: { id: input.sessionId, projectId } })
    if (!session) throw new BadRequestException('sessionId 不属于当前项目')
    const evidence = await this.prisma.labEvidence.findMany({ where: { sessionId: input.sessionId }, orderBy: { createdAt: 'asc' } })
    const independentKinds = new Set(evidence.map((item) => evidenceKindForSuggestion(item.kind)))
    if (independentKinds.size < 2) {
      throw new BadRequestException('Issue/ECO 草稿至少需要两类独立证据，例如 KiCad + 测量、照片 + 波形')
    }
    const suggestionEvidence = evidence.map((item) => ({
      kind: evidenceKindForSuggestion(item.kind),
      ref: item.ref,
      excerpt: item.excerpt ?? undefined,
    }))
    const draft = await this.prisma.labSuggestionDraft.create({
      data: {
        projectId,
        sessionId: input.sessionId,
        kind,
        payloadJson: input.payload as never,
        evidenceJson: suggestionEvidence as never,
      },
    })
    return {
      draft,
      suggestion: {
        id: draft.id,
        agent: 'A6',
        code: kind === 'ISSUE' ? 'A6.ISSUE.DRAFT' : 'A6.ECO.DRAFT',
        target: { objectType: kind === 'ISSUE' ? 'issue' : 'eco', objectId: projectId, version: String(session.designVersion) },
        severity: 'warn',
        confidence: 'high',
        title: kind === 'ISSUE' ? '生成调试 Issue 草稿' : '生成 ECO 草稿',
        detail: kind === 'ISSUE'
          ? 'LabSight 已把现场证据整理成 Issue 草稿；提交前必须由工程师复核并确认。'
          : 'LabSight 已根据调试证据整理工程变更草稿；任何设计写入仍需人工 diff 确认。',
        proposed: input.payload,
        evidence: suggestionEvidence,
        autoApplyForbidden: true,
        createdAt: draft.createdAt.toISOString(),
      },
      hostAction: {
        source: 'ezplm-labsight',
        type: 'labsight:host-action',
        action: kind === 'ISSUE' ? 'create_issue_draft' : 'create_eco_draft',
        projectId,
        draftId: draft.id,
      },
    }
  }

  async acknowledgeDraft(draftId: string, input: { externalObjectId: string; accepted?: boolean }) {
    const draft = await this.prisma.labSuggestionDraft.findUnique({ where: { id: draftId } })
    if (!draft) throw new NotFoundException(`LabSight 草稿不存在: ${draftId}`)
    return this.prisma.labSuggestionDraft.update({
      where: { id: draftId },
      data: {
        externalObjectId: input.externalObjectId,
        status: input.accepted === false ? 'REJECTED' : 'ACCEPTED',
      },
    })
  }

  async addHypothesis(sessionId: string, input: { statement: string; expectedObservation?: string; confidence: number }) {
    await this.projectIdForSession(sessionId)
    return this.prisma.labHypothesis.create({
      data: {
        sessionId,
        statement: input.statement,
        expectedObservation: input.expectedObservation,
        confidence: input.confidence,
      },
    })
  }

  async nextBestTest(sessionId: string) {
    const projectId = await this.projectIdForSession(sessionId)
    const [hypotheses, steps] = await Promise.all([
      this.prisma.labHypothesis.findMany({ where: { sessionId, status: 'OPEN' }, orderBy: { confidence: 'desc' } }),
      this.prisma.debugStep.findMany({
        where: { projectId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
        orderBy: [{ order: 'asc' }],
      }),
    ])
    if (!hypotheses.length) throw new BadRequestException('当前 Session 还没有 OPEN Hypothesis')
    if (!steps.length) throw new BadRequestException('当前项目没有可执行的 Debug Step')

    const ranked = hypotheses.flatMap((hypothesis) => {
      const uncertainty = Math.max(0, 1 - Math.abs(hypothesis.confidence - 0.5) * 2)
      return steps.map((step) => {
        const relevance = textRelevance(
          `${hypothesis.statement} ${hypothesis.expectedObservation ?? ''}`,
          [step.targetNet, step.targetComponent, step.title],
        )
        const effortCost = Math.min(1, (step.estimateMin ?? 5) / 30)
        const tool = (step.toolHint ?? '').toLowerCase()
        const safetyCost = tool.includes('电源') ? 0.8 : tool.includes('示波器') ? 0.2 : tool.includes('万用表') || tool.includes('目视') ? 0.05 : 0.15
        const informationGain = Math.min(1, 0.55 * uncertainty + 0.45 * relevance)
        const score = 0.72 * informationGain + 0.18 * relevance - 0.07 * safetyCost - 0.03 * effortCost
        return {
          hypothesis,
          step,
          informationGain,
          safetyCost,
          effortCost,
          score,
          why: `该测量与假设的目标相关度 ${(relevance * 100).toFixed(0)}%，预计信息增益 ${(informationGain * 100).toFixed(0)}%；安全成本 ${(safetyCost * 100).toFixed(0)}%，预计耗时 ${step.estimateMin ?? 5} 分钟。`,
        }
      })
    }).sort((a, b) => b.score - a.score)

    const best = ranked[0]
    await this.prisma.labTestRecommendation.create({
      data: {
        hypothesisId: best.hypothesis.id,
        debugStepId: best.step.id,
        title: best.step.title,
        expectedObservation: best.hypothesis.expectedObservation ?? best.step.expectedResult,
        informationGain: best.informationGain,
        safetyCost: best.safetyCost,
        effortCost: best.effortCost,
        score: best.score,
        why: best.why,
      },
    })
    return {
      hypothesis: {
        id: best.hypothesis.id,
        statement: best.hypothesis.statement,
        confidence: best.hypothesis.confidence,
      },
      nextTest: {
        id: best.step.id,
        title: best.step.title,
        targetNet: best.step.targetNet,
        targetComponent: best.step.targetComponent,
        toolHint: best.step.toolHint,
        setup: best.step.setupJson,
        expectedObservation: best.hypothesis.expectedObservation ?? best.step.expectedResult,
        score: best.score,
        informationGain: best.informationGain,
        safetyCost: best.safetyCost,
        effortCost: best.effortCost,
        why: best.why,
      },
      alternatives: ranked.slice(1, 4).map((item) => ({
        id: item.step.id,
        title: item.step.title,
        score: item.score,
        why: item.why,
      })),
    }
  }

  async compareGolden(projectId: string, input: { sessionId: string; goldenBoardId: string; targetBoardId?: string }) {
    const session = await this.prisma.debugSession.findFirst({ where: { id: input.sessionId, projectId } })
    if (!session) throw new BadRequestException('sessionId 不属于当前项目')
    const golden = await this.prisma.board.findFirst({ where: { id: input.goldenBoardId, projectId, isGolden: true } })
    if (!golden) throw new BadRequestException('goldenBoardId 不是当前项目的 Golden Board')
    const goldenSession = await this.prisma.debugSession.findFirst({
      where: { boardId: golden.id },
      orderBy: { updatedAt: 'desc' },
    })
    if (!goldenSession) throw new BadRequestException('Golden Board 还没有 Debug Session / Evidence')

    const [baseline, target] = await Promise.all([
      this.prisma.labEvidence.findMany({ where: { sessionId: goldenSession.id } }),
      this.prisma.labEvidence.findMany({ where: { sessionId: input.sessionId } }),
    ])
    const baselineByKey = new Map(baseline.map((item) => [evidenceComparisonKey(item), item]))
    const diffs = target.flatMap((item) => {
      const comparisonKey = evidenceComparisonKey(item)
      const base = baselineByKey.get(comparisonKey)
      if (!base) return []
      const baseValue = measurementValue(base.dataJson)
      const targetValue = measurementValue(item.dataJson)
      let differenceScore: number
      let delta: number | null = null
      if (baseValue !== null && targetValue !== null) {
        delta = targetValue - baseValue
        differenceScore = Math.min(10, Math.abs(delta) / Math.max(Math.abs(baseValue), 1e-6))
      } else {
        differenceScore = JSON.stringify(base.dataJson) === JSON.stringify(item.dataJson) ? 0 : 1
      }
      return [{
        comparisonKey,
        ref: item.ref,
        baselineRef: base.ref,
        kind: item.kind,
        baselineEvidenceId: base.id,
        targetEvidenceId: item.id,
        baselineValue: baseValue,
        targetValue,
        delta,
        differenceScore,
      }]
    }).sort((a, b) => b.differenceScore - a.differenceScore)

    const result = {
      goldenBoardId: golden.id,
      goldenSessionId: goldenSession.id,
      targetSessionId: input.sessionId,
      compared: diffs.length,
      changed: diffs.filter((item) => item.differenceScore > 0.05).length,
      differences: diffs.slice(0, 50),
    }
    const saved = await this.prisma.goldenBoardComparison.create({
      data: {
        projectId,
        sessionId: input.sessionId,
        goldenBoardId: golden.id,
        targetBoardId: input.targetBoardId ?? session.boardId,
        resultJson: result as never,
      },
    })
    return { id: saved.id, ...result }
  }
}
