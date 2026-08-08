import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  AiDiagnosisSchema,
  DesignReviewSchema,
  FindingSchema,
  ModelVisualFindingsSchema,
  InstrumentPresetSchema,
  VisualFindingsSchema,
  requiresConfirm,
  type AgentIntent,
  type AiDiagnosis,
  type DesignReview,
  type Finding,
  type InstrumentPreset,
  type VisualFindings,
} from '@app/contracts'
import {
  SCHEMA_HINTS,
  SKILL_SYSTEM,
  TASK_PROMPTS,
  createProvider,
  dedupe,
  describeProvider,
  droppedRate,
  emptyStats,
  extractJson,
  ground,
  routeIntent,
  runStructured,
  type GuardStats,
  type LlmProvider,
} from '@app/ai'
import { buildDesignDigest, runSchematicRules } from '@app/kicad'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { DesignGraphService } from './design-graph.service'

export interface StreamEvent {
  event: 'meta' | 'narration' | 'tool' | 'card' | 'result' | 'error'
  data: unknown
}

type Json = Record<string, unknown>
const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name)
  private readonly provider: LlmProvider = createProvider()

  constructor(
    private readonly prisma: PrismaService,
    private readonly graphs: DesignGraphService,
    private readonly storage: StorageService,
  ) {
    const d = describeProvider()
    if (d.degraded) {
      this.logger.warn(`LLM_PROVIDER=${d.requested} 缺少 API key，已降级为 mock`)
    } else {
      this.logger.log(`LLM provider: ${d.provider}${d.model ? ` (${d.model})` : ''}`)
    }
  }

  describe() {
    return describeProvider()
  }

  // ---------------------------------------------------------------- 设计审查

  /**
   * L2 规则引擎永远先跑（docs/05 §2）：LLM 的职责是解释与排序，不是发现问题。
   * provider 挂了也依然有完整的规则引擎结果可展示。
   */
  async designReview(projectId: string, persist = false): Promise<DesignReview> {
    const input = await this.graphs.build(projectId)
    const ruleFindings = runSchematicRules(input.graph)

    const parsed = await this.prisma.ruleViolation.findMany({
      where: { projectId, origin: { in: ['ERC', 'DRC'] } },
    })
    const parsedFindings = parsed.map((v) => this.rowToFinding(v))

    const stats = emptyStats()
    const ctx = this.groundingCtx(input)
    let aiFindings: Finding[] = []
    let summary = ''

    const digest = buildDesignDigest(input)
    // origin 由系统赋值（AI），不属于模型该填的字段。
    // 放进校验 schema 会让每条 finding 都因 "origin: Required" 失败，
    // 表现为 LLM 部分永远静默降级、只剩规则引擎结果。
    const ModelReviewSchema = DesignReviewSchema.partial({
      bomRisk: true,
      ercDrc: true,
    }).extend({
      findings: z.array(FindingSchema.omit({ origin: true })).min(1).max(12),
    })

    const result = await runStructured(
      this.provider,
      ModelReviewSchema,
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
            '<schema>',
            SCHEMA_HINTS.design_review,
            '</schema>',
            '',
            TASK_PROMPTS.design_review,
          ].join('\n'),
        },
      ],
      { intent: 'design_review' },
    )

    if (result.ok && result.value) {
      summary = result.value.summary
      aiFindings = ground(
        (result.value.findings ?? []).map((f) => ({ ...f, origin: 'AI' as const })),
        ctx,
        stats,
      )
    } else if (result.error) {
      this.logger.warn(`design_review 降级：${result.error}`)
    }

    const merged = dedupe([...ruleFindings, ...parsedFindings, ...aiFindings], stats)
    this.reportDropped('design_review', stats, (result.value?.findings ?? []).length)

    // 截断必须按严重度而不是按来源：dedupe 的排序把 RULE_ENGINE 放在前面，
    // 直接 slice(0,12) 会把 AI 独有的新发现全部挤出去，等于 LLM 白跑一趟。
    const SEV = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const
    const ranked = [...merged].sort((a, b) => SEV[a.severity] - SEV[b.severity])

    const open = merged.filter((f) => !f.resolved)
    const review: DesignReview = {
      summary:
        summary ||
        `规则引擎检出 ${merged.length} 条设计问题，其中高风险 ${open.filter((f) => f.severity === 'CRITICAL').length} 条。`,
      findings: ranked.slice(0, 12),
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

  // ------------------------------------------------------------ 波形分析

  /** 分析一次捕获 → AiDiagnosis。captureId 唯一，重分析必须 upsert（docs/05 §7.3）。 */
  async analyzeCapture(captureId: string, persist = true): Promise<AiDiagnosis> {
    const capture = await this.prisma.capture.findUnique({
      where: { id: captureId },
      include: { net: { select: { name: true } } },
    })
    if (!capture) throw new NotFoundException(`捕获不存在: ${captureId}`)

    const input = await this.graphs.build(capture.projectId)
    const m = asJson(capture.measurementsJson)
    const scenario = asJson(capture.hardwareSetupJson).scenario as string | undefined

    // L2：确定性测量规则先跑
    const measurementFindings = this.measurementRules(m, input)

    const result = await runStructured(
      this.provider,
      AiDiagnosisSchema.omit({ id: true, captureId: true, createdAt: true }),
      [
        { role: 'system', content: SKILL_SYSTEM.waveform_analyze ?? '' },
        {
          role: 'user',
          content: [
            '<context>',
            buildDesignDigest(input),
            '',
            `[MEASUREMENT] ${capture.label ?? captureId}`,
            `  ${JSON.stringify(m)}`,
            '',
            '[EVIDENCE] 测量规则已判定：',
            ...measurementFindings.map((f) => `  ${f.code}: ${f.title} — ${f.evidence[0]}`),
            '',
            '[VISION] 视觉检测结果：',
            ...(await this.visionSummary(capture.projectId)),
            '</context>',
            '',
            '<schema>',
            SCHEMA_HINTS.waveform_analyze,
            '</schema>',
            '',
            TASK_PROMPTS.waveform_analyze,
          ].join('\n'),
        },
      ],
      { intent: 'waveform_analyze', scenario },
    )

    const diagnosis: AiDiagnosis =
      result.ok && result.value
        ? this.groundDiagnosis(result.value, input, measurementFindings)
        : this.fallbackDiagnosis(measurementFindings, m)

    if (persist) {
      const saved = await this.prisma.aiDiagnosis.upsert({
        where: { captureId },
        update: {
          severity: diagnosis.severity,
          rootCause: diagnosis.rootCause,
          confidence: diagnosis.confidence,
          evidenceJson: diagnosis.evidence,
          recommendationsJson: diagnosis.recommendations as never,
          rawJson: {
            alternativeCauses: diagnosis.alternativeCauses,
            intent: 'waveform_analyze',
            provider: this.provider.name,
            degraded: !result.ok,
          } as never,
        },
        create: {
          captureId,
          projectId: capture.projectId,
          severity: diagnosis.severity,
          rootCause: diagnosis.rootCause,
          confidence: diagnosis.confidence,
          evidenceJson: diagnosis.evidence,
          recommendationsJson: diagnosis.recommendations as never,
          rawJson: {
            alternativeCauses: diagnosis.alternativeCauses,
            intent: 'waveform_analyze',
            provider: this.provider.name,
            degraded: !result.ok,
          } as never,
        },
      })
      return { ...diagnosis, id: saved.id, captureId, createdAt: saved.createdAt.toISOString() }
    }

    return diagnosis
  }

  // ------------------------------------------------------------ 视觉分析

  async analyzePhoto(photoId: string, persist = true): Promise<VisualFindings> {
    const photo = await this.prisma.boardPhoto.findUnique({
      where: { id: photoId },
      include: { visualFindings: true },
    })
    if (!photo) throw new NotFoundException(`照片不存在: ${photoId}`)

    const input = await this.graphs.build(photo.projectId)
    const refs = input.graph.components.map((c) => c.ref).join(', ')

    // 图像来源有两种：上传后落在对象存储（objectKey 是路径），
    // 或直接内联 data URL。seed 里的示意图两者都不是，只能用已落库结果。
    const image = await this.loadImage(photo.objectKey)

    if (this.provider.name === 'mock' || !image) {
      return {
        photoId,
        findings: photo.visualFindings.map((f) => ({
          id: f.id,
          code: f.code as VisualFindings['findings'][number]['code'],
          title: f.title,
          detail: f.detail,
          confidence: f.confidence,
          severity: f.severity as VisualFindings['findings'][number]['severity'],
          componentRef: f.componentRef,
          certainty: f.confidence >= 0.95 && f.severity === '正常' ? 'CONFIRMED' : 'SUSPECTED',
        })),
      }
    }

    const { mimeType: mime, base64: b64 } = image
    let findings: Omit<VisualFindings['findings'][number], 'id'>[] = []
    try {
      this.logger.log(`photo_analyze: 走真实多模态，图片 ${(b64.length / 1024) | 0} KB`)
      const raw = await this.provider.vision(
        [{ data: b64, mimeType: mime }],
        [
          SKILL_SYSTEM.photo_analyze,
          '',
          `<context>板上器件位号：${refs}</context>`,
          '<schema>',
          SCHEMA_HINTS.photo_analyze,
          '</schema>',
          TASK_PROMPTS.photo_analyze,
        ].join('\n'),
        { json: true },
      )
      const parsed = ModelVisualFindingsSchema.safeParse(extractJson(raw))
      if (parsed.success) {
        const refSet = new Set(input.graph.components.map((c) => c.ref))
        const before = parsed.data.findings.length
        findings = parsed.data.findings
          .filter((f) => !f.componentRef || refSet.has(f.componentRef))
          // 置信度 <0.6 不得标 CONFIRMED（docs/05 §8.3）
          .map((f) => ({ ...f, certainty: f.confidence < 0.6 ? 'SUSPECTED' : f.certainty }))
        if (findings.length < before) {
          this.logger.warn(`photo_analyze: ${before - findings.length} 条因位号不存在被丢弃`)
        }
      } else {
        // 静默吞掉解析失败会让页面显示「0 条」而无从追查
        this.logger.warn(
          `photo_analyze schema 校验失败：${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}｜原始输出前 200 字：${raw.slice(0, 200)}`,
        )
      }
    } catch (err) {
      this.logger.warn(`photo_analyze 降级：${(err as Error).message}`)
    }

    if (persist && findings.length > 0) {
      await this.prisma.$transaction([
        this.prisma.visualFinding.deleteMany({ where: { photoId } }),
        this.prisma.visualFinding.createMany({
          data: findings.map((f) => ({
            photoId,
            code: f.code,
            title: f.title,
            detail: f.detail,
            confidence: f.confidence,
            severity: f.severity,
            componentRef: f.componentRef ?? null,
          })),
        }),
      ])
      // 回读拿数据库赋的 id，响应 schema 要求它
      const saved = await this.prisma.visualFinding.findMany({
        where: { photoId },
        orderBy: { confidence: 'desc' },
      })
      return {
        photoId,
        findings: saved.map((f) => ({
          id: f.id,
          code: f.code as VisualFindings['findings'][number]['code'],
          title: f.title,
          detail: f.detail,
          confidence: f.confidence,
          severity: f.severity as VisualFindings['findings'][number]['severity'],
          componentRef: f.componentRef,
          certainty: (f.confidence < 0.6 ? 'SUSPECTED' : 'CONFIRMED') as 'CONFIRMED' | 'SUSPECTED',
        })),
      }
    }

    // 未落库时 id 还不存在，用稳定的占位串，前端只拿它做 key
    return {
      photoId,
      findings: findings.map((f, i) => ({ ...f, id: `pending-${i}` })),
    }
  }


  /**
   * 取回图像用于多模态分析。
   *
   * 上传的照片 objectKey 是对象存储路径，不是 data URL —— 之前直接判
   * startsWith('data:') 导致真实上传的照片永远走不到 vision，静默回落到已落库结果。
   */
  private async loadImage(
    objectKey: string,
  ): Promise<{ mimeType: string; base64: string } | null> {
    const inline = /^data:([^;]+);base64,(.+)$/.exec(objectKey)
    if (inline?.[1] && inline[2]) return { mimeType: inline[1], base64: inline[2] }

    const buf = await this.storage.get(objectKey)
    if (!buf) return null

    // 按扩展名判 MIME；存储层不保留 content-type
    const ext = objectKey.toLowerCase().split('.').pop() ?? ''
    const mimeType =
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return { mimeType, base64: buf.toString('base64') }
  }

  // ------------------------------------------------------------ 测量指引

  async measureGuide(projectId: string, question: string): Promise<InstrumentPreset & { rationale?: string }> {
    const input = await this.graphs.build(projectId)

    const GuideSchema = InstrumentPresetSchema.extend({
      rationale: z.string().max(400).optional(),
      expectedValue: z
        .object({ value: z.string(), unit: z.string(), label: z.string() })
        .optional(),
    })

    const result = await runStructured(this.provider, GuideSchema, [
      { role: 'system', content: SKILL_SYSTEM.measure_guide ?? '' },
      {
        role: 'user',
        content: [
          '<context>',
          buildDesignDigest(input),
          '</context>',
          '<schema>',
          SCHEMA_HINTS.measure_guide,
          '</schema>',
          `${TASK_PROMPTS.measure_guide}\n\n问题：${question}`,
        ].join('\n'),
      },
    ])

    const preset: InstrumentPreset & { rationale?: string } =
      result.ok && result.value
        ? (result.value as never)
        : this.guideFallback(input, question, result.error)

    return this.applySafety(preset)
  }

  // ------------------------------------------------------------ 流式对话

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

      const recent = await this.prisma.capture.findMany({
        where: { projectId: params.projectId, kind: 'OSCILLOSCOPE' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      })
      const measurement = recent[0]
        ? `\n[MEASUREMENT] ${recent[0].label}\n  ${JSON.stringify(recent[0].measurementsJson)}`
        : ''

      const stream = this.provider.chatStream(
        [
          { role: 'system', content: SKILL_SYSTEM[intent] ?? SKILL_SYSTEM.general_chat ?? '' },
          {
            role: 'user',
            content: `<context>\n${digest}${measurement}\n</context>\n\n${params.message}`,
          },
        ],
        { intent, scenario: params.scenario },
      )

      let full = ''
      for await (const delta of stream) {
        full += delta
        yield { event: 'narration', data: { delta } }
      }

      await this.appendThread(params.projectId, intent, params.message, full)
      yield { event: 'result', data: { intent, text: full } }
    } catch (err) {
      yield {
        event: 'error',
        data: { code: 'PROVIDER_ERROR', message: (err as Error).message, degraded: true },
      }
    }
  }

  // ------------------------------------------------------------ 内部工具

  /**
   * AI 不可用时的测量指引：从问题里匹配位号/网络/测试点，给出真实接线而不是占位文字。
   * 降级路径也必须是可执行的，否则页面等于空白。
   */
  private guideFallback(
    input: Awaited<ReturnType<DesignGraphService['build']>>,
    question: string,
    error?: string,
  ): InstrumentPreset & { rationale?: string } {
    const g = input.graph
    const ref = g.components.find((c) => new RegExp(`\\b${c.ref}\\b`, 'i').test(question))
    const net = g.nets.find((n) => question.includes(n.name))
    const tp = input.testPoints.find((t) => question.includes(t.label) || t.netName === net?.name)

    // 问题提到某个器件时，优先挂到能反映该问题的引脚
    const pin =
      (/反相|IN-/.test(question) ? ref?.pins.find((p) => p.name === 'IN-') : undefined) ??
      (/同相|IN\+/.test(question) ? ref?.pins.find((p) => p.name === 'IN+') : undefined) ??
      ref?.pins.find((p) => p.netName === net?.name) ??
      ref?.pins.find((p) => p.type === 'input')

    const target =
      pin && ref
        ? `${ref.ref}.${pin.number}${pin.name ? ` (${pin.name})` : ''}`
        : tp
          ? `${tp.label}${tp.netName ? ` (${tp.netName})` : ''}`
          : (net?.name ?? '目标网点')

    return {
      mode: 'DMM',
      wiring: [
        { from: 'DMM+ / CH1 正极', to: target },
        { from: 'DMM- / CH1 负极', to: 'GND（模拟地）' },
      ],
      range: 'Auto',
      trigger: 'N/A（直流测量）',
      requiresConfirm: false,
      safetyNotes: ['测阻值前必须断电'],
      rationale: error
        ? `AI 不可用（${error.slice(0, 80)}），以下方案由设计图直接推导`
        : '由设计图直接推导',
    }
  }

  private groundingCtx(input: Awaited<ReturnType<DesignGraphService['build']>>) {
    return {
      componentRefs: new Set(input.graph.components.map((c) => c.ref)),
      netNames: new Set(input.graph.nets.map((n) => n.name)),
    }
  }

  private reportDropped(intent: string, stats: GuardStats, total: number) {
    const rate = droppedRate(stats, total)
    if (rate > 0.3) {
      this.logger.warn(
        `${intent} droppedRate ${(rate * 100).toFixed(0)}%（未知位号 ${stats.unknownRef} / 未知网络 ${stats.unknownNet} / 空泛证据 ${stats.vagueEvidence}）`,
      )
    }
  }

  /** 诊断也要过 grounding：位号必须存在，证据必须含数值 */
  private groundDiagnosis(
    d: Omit<AiDiagnosis, 'id' | 'captureId' | 'createdAt'>,
    input: Awaited<ReturnType<DesignGraphService['build']>>,
    measurementFindings: Finding[],
  ): AiDiagnosis {
    const refs = new Set(input.graph.components.map((c) => c.ref))
    const nets = new Set(input.graph.nets.map((n) => n.name))

    // L2 测量规则是「本次测量有没有故障」的权威。
    //
    // 模型会把「这块板的设计缺陷有多严重」和「本次测量有多严重」混为一谈：
    // normal 场景下它照样能讲出 Vref 偏置缺陷（那是真的），于是给出 CRITICAL
    // 和一个故障 code —— 可那条缺陷在本次测量里已经被补焊解决了。
    // 规则一条都没检出时，本次测量就不存在严重故障，severity 封顶到 WARNING，
    // primaryCode 清空。模型的解释保留在 rootCause 与 evidence 里，不丢信息。
    const noFault = measurementFindings.length === 0
    const severity: AiDiagnosis['severity'] =
      noFault && d.severity === 'CRITICAL' ? 'WARNING' : d.severity
    if (noFault && d.severity === 'CRITICAL') {
      this.logger.warn('测量规则未检出故障，模型判 CRITICAL，已按 L2 结论降为 WARNING')
    }

    const evidence = d.evidence.filter((e) => /\d|[A-Z]{1,3}\d+/.test(e))
    const recommendations = d.recommendations
      .filter((r) => !r.targetComponent || refs.has(r.targetComponent))
      .filter((r) => !r.targetNet || nets.has(r.targetNet))
      .map((r) => ({
        ...r,
        instrumentPreset: r.instrumentPreset
          ? (this.applySafety(r.instrumentPreset as InstrumentPreset) as never)
          : undefined,
      }))

    // grounding 可能把整个数组过滤空 —— 模型引用了一批不存在的位号时就会发生。
    // evidence 与 recommendations 都是 min(1)，清空会让响应 schema 校验失败并 500。
    // 全被丢弃说明这次输出整体不可信，退回测量规则结论而不是产出半个对象。
    if (evidence.length === 0 || recommendations.length === 0) {
      this.logger.warn(
        `诊断被 grounding 清空（evidence ${d.evidence.length}→${evidence.length}，` +
          `recommendations ${d.recommendations.length}→${recommendations.length}），退回规则结论`,
      )
      return this.fallbackDiagnosis(measurementFindings, {})
    }

    return {
      ...d,
      severity,
      primaryCode: noFault ? null : d.primaryCode,
      evidence,
      recommendations,
    }
  }

  /** docs/05 §9.4：安全层是确定性后处理，模型无权跳过 */
  private applySafety<T extends InstrumentPreset>(preset: T): T {
    const awgs = Array.isArray(preset.awg) ? preset.awg : preset.awg ? [preset.awg] : []
    const danger = awgs.some((a) => requiresConfirm(a))
    const notes = new Set(preset.safetyNotes ?? [])
    if (preset.mode === 'DMM') notes.add('测阻值前必须断电')
    if (danger) notes.add('输出幅度或偏置超出安全阈值，下发前必须二次确认')
    return { ...preset, requiresConfirm: danger, safetyNotes: [...notes] }
  }

  /** L2 测量规则（docs/05 §5.2 测量族），判定顺序固定 */
  private measurementRules(
    m: Json,
    input: Awaited<ReturnType<DesignGraphService['build']>>,
  ): Finding[] {
    const ch2 = asJson(m.ch2)
    const ch1 = asJson(m.ch1)
    const gain = Number(m.gain ?? 0)
    const thd = Number(ch2.thdnPct ?? 0)
    const vmax = Number(ch2.vmax ?? 0)
    const vmin = Number(ch2.vmin ?? 0)
    const vpp2 = Number(ch2.vpp ?? 0)
    const out: Finding[] = []

    const topo = /gain=(-?\d+)/.exec(input.graph.components.length ? buildDesignDigest(input) : '')
    const expected = topo?.[1] ? Math.abs(Number(topo[1])) : 10

    const mk = (
      code: Finding['code'],
      severity: Finding['severity'],
      title: string,
      evidence: string[],
      suggestion: string,
    ): Finding => ({
      code,
      origin: 'MEASUREMENT',
      severity,
      title,
      description: evidence[0] ?? title,
      evidence,
      risk: '',
      suggestion,
      resolved: false,
    })

    if (vpp2 < 0.05) {
      out.push(
        mk(
          'NO_RESPONSE',
          'CRITICAL',
          '输出无响应',
          [`CH2 Vpp=${vpp2.toFixed(3)}V`, `直流 ${(Number(ch2.offsetV ?? 0) * 1000).toFixed(0)}mV`],
          '检查供电与偏置，优先测同相端直流电压',
        ),
      )
      return out
    }

    const railed = vmax > 4.9 || vmin < 0.1
    if (thd > 5 && railed) {
      out.push(
        mk(
          'OUTPUT_CLIPPING',
          'CRITICAL',
          '输出削顶',
          [`THD+N=${thd.toFixed(2)}%`, `Vmax=${vmax.toFixed(2)}V Vmin=${vmin.toFixed(2)}V 已贴轨`],
          `降低输入幅度到 ≤${(4.96 / expected).toFixed(2)}Vpp 再复测`,
        ),
      )
    } else if (Math.abs(gain - expected) / expected > 0.1) {
      const ev = [
        `期望 |Av|=${expected}，实测 ${gain.toFixed(2)}`,
        `THD+N=${thd.toFixed(2)}% 且 Vmax=${vmax.toFixed(2)}V/Vmin=${vmin.toFixed(2)}V 未贴轨，可排除削顶`,
      ]
      // 增益恰为期望的一半，是对反馈网络的确定性推断：
      // 并联一个等值电阻会让 Rf 减半，增益随之减半
      const fb = this.feedbackRefs(input)
      if (Math.abs(expected / gain - 2) < 0.15 && fb.rf) {
        ev.push(
          `实测恰为期望的 1/2，等效 Rf ≈ ${fb.rf}(${fb.rfValue}) 的一半` +
            (fb.parallel ? `，与设计为 DNP 的 ${fb.parallel} 并联即可解释` : ''),
        )
      }
      out.push(
        mk(
          'GAIN_MISMATCH',
          'CRITICAL',
          '增益不符',
          ev,
          fb.rf ? `断电测 ${fb.rf} 两端阻值，预期 ${fb.rfValue}` : '检查反馈网络阻值',
        ),
      )
    }

    if (thd > 1 && thd <= 5) {
      out.push(
        mk('NOISE_EXCESSIVE', 'WARNING', '噪声偏高', [`THD+N=${thd.toFixed(2)}%`], '检查去耦与地回路'),
      )
    }
    if (Math.abs(Number(ch1.freqHz ?? 0) - Number(ch2.freqHz ?? 0)) > 5) {
      out.push(
        mk(
          'FREQ_MISMATCH',
          'WARNING',
          '频率不符',
          [`CH1 ${Number(ch1.freqHz).toFixed(1)}Hz vs CH2 ${Number(ch2.freqHz).toFixed(1)}Hz`],
          '检查信号链是否有非线性或丢周期',
        ),
      )
    }
    return out
  }


  /** 从设计图找出反馈电阻与可能并联的 DNP 位，供确定性推断使用 */
  private feedbackRefs(input: Awaited<ReturnType<DesignGraphService['build']>>) {
    const g = input.graph
    const u = g.components.find((c) => c.category === '运算放大器')
    const empty = { rf: null as string | null, rfValue: null as string | null, parallel: null as string | null }
    if (!u) return empty
    const inv = u.pins.find((p) => p.name === 'IN-')?.netName
    const outNet = u.pins.find((p) => p.name === 'OUT')?.netName
    const rf = g.components.find(
      (c) =>
        c.category === '电阻' &&
        c.pins.some((p) => p.netName === inv) &&
        c.pins.some((p) => p.netName === outNet),
    )
    if (!rf) return empty
    const parallel = g.components.find(
      (c) => c.category === '电阻' && c.meta.dnp === true && c.value === rf.value,
    )
    return { rf: rf.ref, rfValue: rf.value, parallel: parallel?.ref ?? null }
  }

  private fallbackDiagnosis(findings: Finding[], m: Json): AiDiagnosis {
    const top = findings[0]
    return {
      severity: top?.severity ?? 'INFO',
      primaryCode: top?.code ?? null,
      rootCause: top ? `${top.title}：${top.evidence.join('；')}` : '未检出异常',
      confidence: top ? 0.55 : 0.7,
      evidence: top?.evidence ?? [`Gain=${Number(m.gain ?? 0).toFixed(2)}`],
      alternativeCauses: [],
      recommendations: [
        { order: 1, action: top?.suggestion ?? '保持当前设置继续观察', detail: 'AI 不可用，以上为测量规则结论' },
      ],
    }
  }

  private async visionSummary(projectId: string): Promise<string[]> {
    const photos = await this.prisma.boardPhoto.findMany({
      where: { projectId },
      include: { visualFindings: { orderBy: { confidence: 'desc' }, take: 5 } },
    })
    return photos.flatMap((p) =>
      p.visualFindings.map(
        (f) => `  ${f.code}(${f.confidence.toFixed(2)}, ${f.severity}): ${f.title}${f.componentRef ? ` @${f.componentRef}` : ''}`,
      ),
    )
  }

  private async appendThread(projectId: string, mode: string, question: string, answer: string) {
    const existing = await this.prisma.aiThread.findFirst({ where: { projectId, mode } })
    const ts = new Date().toISOString()
    const turns = [
      { role: 'user', content: question, ts },
      { role: 'assistant', content: answer.slice(0, 8000), ts },
    ]
    if (existing) {
      const prev = Array.isArray(existing.messagesJson) ? existing.messagesJson : []
      // docs/05 §16.3：超过 20 轮只保留最近 12 条
      const next = [...prev, ...turns].slice(-24)
      await this.prisma.aiThread.update({
        where: { id: existing.id },
        data: { messagesJson: next as never },
      })
    } else {
      await this.prisma.aiThread.create({
        data: { projectId, mode, messagesJson: turns as never },
      })
    }
  }

  private rowToFinding(v: {
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
}
