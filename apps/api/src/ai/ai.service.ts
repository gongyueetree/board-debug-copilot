import { Injectable, Logger } from '@nestjs/common'
import {
  DesignReviewSchema,
  type AgentIntent,
  type DesignReview,
  type Finding,
} from '@app/contracts'
import {
  SKILL_SYSTEM,
  createProvider,
  dedupe,
  droppedRate,
  emptyStats,
  extractJson,
  ground,
  routeIntent,
  validate,
  type LlmProvider,
} from '@app/ai'
import { buildDesignDigest, runSchematicRules } from '@app/kicad'
import { PrismaService } from '../prisma/prisma.service'
import { DesignGraphService } from './design-graph.service'

export interface StreamEvent {
  event: 'meta' | 'narration' | 'tool' | 'card' | 'result' | 'error'
  data: unknown
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)
  private readonly provider: LlmProvider = createProvider()

  constructor(
    private readonly prisma: PrismaService,
    private readonly graphs: DesignGraphService,
  ) {}

  get providerName() {
    return this.provider.name
  }

  /**
   * 设计审查。
   *
   * L2 规则引擎永远先跑（docs/05 §2）：LLM 的职责是解释与排序，不是发现问题。
   * 所以即使 provider 挂了，页面依然有完整的规则引擎结果可展示。
   */
  async designReview(projectId: string, persist = false): Promise<DesignReview> {
    const input = await this.graphs.build(projectId)
    const ruleFindings = runSchematicRules(input.graph)

    // ERC/DRC 来自 KiCad 解析阶段而非规则引擎，从库里取出一并合并
    const parsed = await this.prisma.ruleViolation.findMany({
      where: { projectId, origin: { in: ['ERC', 'DRC'] } },
    })
    const parsedFindings: Finding[] = parsed.map((v) => ({
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
    }))

    const stats = emptyStats()
    const ctx = {
      componentRefs: new Set(input.graph.components.map((c) => c.ref)),
      netNames: new Set(input.graph.nets.map((n) => n.name)),
    }

    let aiFindings: Finding[] = []
    let summary = ''

    try {
      const digest = buildDesignDigest(input)
      const raw = await this.provider.chat(
        [
          { role: 'system', content: SKILL_SYSTEM.design_review ?? '' },
          {
            role: 'user',
            content: [
              '<context>',
              digest,
              '',
              '[EVIDENCE] 规则引擎已给出以下发现，不要复述：',
              ...ruleFindings.map((f) => `  ${f.code}(${f.severity}): ${f.title}`),
              '</context>',
              '',
              '请补充规则引擎覆盖不到的设计推理问题，输出 DesignReview JSON。',
            ].join('\n'),
          },
        ],
        { intent: 'design_review' },
      )

      const parsed = extractJson(raw)
      const v = validate(DesignReviewSchema.partial({ bomRisk: true, ercDrc: true }), parsed)
      if (v.ok) {
        summary = v.value.summary
        aiFindings = ground(
          (v.value.findings ?? []).map((f) => ({ ...f, origin: 'AI' as const })),
          ctx,
          stats,
        )
      } else {
        this.logger.warn(`design_review schema 校验失败: ${v.issues}`)
      }
    } catch (err) {
      // 降级：只展示规则引擎结果（docs/05 §9.6）
      this.logger.warn(`design_review LLM 阶段降级: ${(err as Error).message}`)
    }

    const merged = dedupe([...ruleFindings, ...parsedFindings, ...aiFindings], stats)
    const open = merged.filter((f) => !f.resolved)
    const rate = droppedRate(stats, aiFindings.length + stats.unknownRef + stats.vagueEvidence)
    if (rate > 0.3) this.logger.warn(`droppedRate ${(rate * 100).toFixed(0)}% 偏高，检查 prompt`)

    const review: DesignReview = {
      summary:
        summary ||
        `规则引擎检出 ${merged.length} 条设计问题，其中高风险 ${open.filter((f) => f.severity === 'CRITICAL').length} 条。`,
      findings: merged.slice(0, 12),
      bomRisk: {
        high: open.filter((f) => f.severity === 'CRITICAL').length,
        medium: open.filter((f) => f.severity === 'WARNING').length,
        low: open.filter((f) => f.severity === 'INFO').length,
        total: merged.length,
      },
      ercDrc: {
        errors: open.filter((f) => f.origin === 'ERC' && f.severity === 'CRITICAL').length,
        warnings: open.filter((f) => f.origin === 'ERC' && f.severity !== 'CRITICAL').length,
        violations: open.filter((f) => f.origin === 'DRC').length,
      },
    }

    if (persist) await this.persistFindings(projectId, merged)
    return review
  }

  /** 把规则引擎结果落库，覆盖同 code+位置的旧记录 */
  private async persistFindings(projectId: string, findings: Finding[]) {
    await this.prisma.$transaction([
      this.prisma.ruleViolation.deleteMany({
        where: { projectId, origin: { in: ['RULE_ENGINE', 'AI'] } },
      }),
      this.prisma.ruleViolation.createMany({
        data: findings
          .filter((f) => f.origin === 'RULE_ENGINE' || f.origin === 'AI')
          .map((f) => ({
            projectId,
            origin: f.origin,
            code: f.code,
            severity: f.severity,
            title: f.title,
            description: f.description,
            evidence: f.evidence.join('\n'),
            risk: f.risk,
            suggestion: f.suggestion,
            recommendedTest: f.recommendedTest ?? null,
            componentRef: f.componentRef ?? null,
            netName: f.netName ?? null,
            resolved: f.resolved,
          })),
      }),
    ])
  }

  /**
   * SSE 流式对话（docs/05 §10）。
   * 事件分型：meta / narration / tool / card / result / error。
   */
  async *chat(params: {
    projectId: string
    message: string
    mode?: string
    scenario?: string
  }): AsyncGenerator<StreamEvent> {
    const intent: AgentIntent = routeIntent({ mode: params.mode, message: params.message })
    yield { event: 'meta', data: { intent, provider: this.provider.name } }

    try {
      const input = await this.graphs.build(params.projectId)
      const digest = buildDesignDigest(input)
      yield {
        event: 'tool',
        data: { name: 'buildDesignDigest', status: 'done', summary: '已装配设计上下文' },
      }

      const stream = this.provider.chatStream(
        [
          { role: 'system', content: SKILL_SYSTEM[intent] ?? SKILL_SYSTEM.general_chat ?? '' },
          { role: 'user', content: `<context>\n${digest}\n</context>\n\n${params.message}` },
        ],
        { intent, scenario: params.scenario },
      )

      let full = ''
      for await (const delta of stream) {
        full += delta
        yield { event: 'narration', data: { delta } }
      }

      yield { event: 'result', data: { intent, text: full } }
    } catch (err) {
      yield {
        event: 'error',
        data: { code: 'PROVIDER_ERROR', message: (err as Error).message, degraded: true },
      }
    }
  }
}
