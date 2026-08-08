import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

type Json = Record<string, unknown>
const asJson = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)

/**
 * 报告生成。docs/05 §8.3：只汇总已落库的事实，不新增结论。
 * 因此这里是纯聚合，不调 LLM —— 报告里出现的每个数字都能追溯到一张表。
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)

    const [violations, captures, steps, photos, diagnoses, prev] = await Promise.all([
      this.prisma.ruleViolation.findMany({
        where: { projectId },
        orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.capture.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.debugStep.findMany({
        where: { projectId },
        orderBy: { order: 'asc' },
        include: { parent: { select: { order: true, title: true } } },
      }),
      this.prisma.boardPhoto.findMany({
        where: { projectId },
        include: { visualFindings: { orderBy: { confidence: 'desc' } } },
      }),
      this.prisma.aiDiagnosis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.debugReport.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const open = violations.filter((v) => !v.resolved)
    const critical = open.filter((v) => v.severity === 'CRITICAL')
    const leaves = steps.filter((s) => s.parentId !== null)
    const groups = steps.filter((s) => s.parentId === null)
    const done = leaves.filter((s) => s.status === 'COMPLETED')
    const scope = captures.filter((c) => c.kind === 'OSCILLOSCOPE')
    const diagnosis = diagnoses[0]
    const recs = Array.isArray(diagnosis?.recommendationsJson)
      ? (diagnosis.recommendationsJson as { order: number; action: string }[])
      : []
    const evidence = Array.isArray(diagnosis?.evidenceJson) ? (diagnosis.evidenceJson as string[]) : []

    const stats = {
      issues: critical.length,
      resolved: violations.filter((v) => v.resolved && v.severity !== 'INFO').length,
      improvements: open.filter((v) => v.severity === 'INFO').length,
      measurements: captures.length,
      aiSuggestions: recs.length + open.filter((v) => v.origin === 'AI' && v.recommendedTest).length,
    }

    const toc = [
      { id: 'summary', title: '项目摘要', level: 1 },
      { id: 'summary-info', title: '项目信息', level: 2 },
      { id: 'summary-overview', title: '调试概览', level: 2 },
      { id: 'design', title: '设计审查', level: 1 },
      { id: 'design-ercdrc', title: 'ERC/DRC 结果', level: 2 },
      { id: 'design-risks', title: '高风险项', level: 2 },
      { id: 'photos', title: 'PCB 照片', level: 1 },
      { id: 'measurements', title: '测量数据', level: 1 },
      { id: 'diagnosis', title: 'AI 诊断', level: 1 },
      { id: 'process', title: '调试过程', level: 1 },
      { id: 'conclusion', title: '结论与建议', level: 1 },
    ]

    const md: string[] = []
    md.push(`# ${project.name} 调试报告`, '')

    md.push('## 1 项目摘要', '')
    md.push(`本次调试共发现 ${critical.length} 个高风险问题，${open.length} 项未解决，`)
    md.push(`完成 ${done.length}/${leaves.length} 个调试步骤，采集 ${captures.length} 次测量。`, '')
    md.push('| 项目名称 | ' + project.name + ' |')
    md.push('| --- | --- |')
    md.push('| 当前问题 | ' + (project.currentIssue ?? '—') + ' |')
    md.push('| 状态 | ' + project.status + ' |')
    md.push('| 调试工具 | ADALM2000 |')
    md.push('| 测量次数 | ' + captures.length + ' |', '')

    md.push('## 2 设计审查', '')
    const erc = open.filter((v) => v.origin === 'ERC')
    md.push(
      `ERC 错误 ${erc.filter((v) => v.severity === 'CRITICAL').length}，` +
        `ERC 警告 ${erc.filter((v) => v.severity !== 'CRITICAL').length}，` +
        `DRC 违规 ${open.filter((v) => v.origin === 'DRC').length}。`,
      '',
    )
    md.push(`规则引擎与 AI 共输出 ${violations.length} 条发现，未解决 ${open.length} 条。`, '')
    md.push('### 高风险项', '')
    for (const v of critical) {
      md.push(`**${v.title}**${v.componentRef ? `（${v.componentRef}）` : ''}`)
      md.push('')
      md.push(v.description)
      md.push('')
      for (const e of (v.evidence ?? '').split('\n').filter(Boolean)) md.push(`- ${e}`)
      if (v.suggestion) md.push('', `建议：${v.suggestion}`)
      md.push('')
    }

    md.push('## 3 PCB 照片', '')
    for (const p of photos) {
      const a = asJson(p.alignmentJson)
      const map = asJson(a.componentMapping)
      md.push(
        `对齐状态 ${String(a.status ?? '未对齐')}，元器件映射 ${num(map.matchedPct)}%（${num(map.matched)}/${num(map.total)}）。`,
        '',
      )
      for (const f of p.visualFindings) {
        md.push(
          `- ${f.title}（${f.severity}，置信度 ${Math.round(f.confidence * 100)}%）${f.componentRef ? ` @${f.componentRef}` : ''}：${f.detail}`,
        )
      }
      md.push('')
    }

    md.push('## 4 测量数据', '')
    if (scope.length > 0) {
      md.push('| 捕获 | CH1 Vpp | CH2 Vpp | Gain | Phase | THD+N |')
      md.push('| --- | --- | --- | --- | --- | --- |')
      for (const c of scope) {
        const m = asJson(c.measurementsJson)
        const c1 = asJson(m.ch1)
        const c2 = asJson(m.ch2)
        md.push(
          `| ${c.label ?? c.id.slice(0, 8)} | ${num(c1.vpp).toFixed(3)} V | ${num(c2.vpp).toFixed(3)} V | ` +
            `${num(m.gain).toFixed(2)} V/V | ${num(m.phaseDeviationDeg).toFixed(1)}° | ${num(c2.thdnPct).toFixed(2)}% |`,
        )
      }
      md.push('')
    }

    md.push('## 5 AI 诊断', '')
    if (diagnosis) {
      md.push(`根因：${diagnosis.rootCause}`, '')
      md.push(`置信度：${Math.round(diagnosis.confidence * 100)}%`, '')
      md.push('证据：', '')
      for (const e of evidence) md.push(`- ${e}`)
      md.push('', '推荐动作：', '')
      for (const r of recs) md.push(`${r.order}. ${r.action}`)
      md.push('')
    } else {
      md.push('尚未生成诊断。', '')
    }

    md.push('## 6 调试过程', '')
    md.push(`${groups.length} 个分组共 ${leaves.length} 步，已完成 ${done.length} 步。`, '')
    for (const s of done) {
      const r = asJson(s.resultJson)
      md.push(
        `- ${s.parent?.order ?? ''}.${s.order} ${s.title}：${String(r.measured ?? '—')} ` +
          `（${String(r.verdict ?? '已完成')}）${r.note ? ` — ${String(r.note)}` : ''}`,
      )
    }
    md.push('')

    md.push('## 7 结论与建议', '')
    let n = 1
    for (const v of critical) md.push(`${n++}. ${v.suggestion || v.title}`)
    for (const r of recs.slice(0, 3)) md.push(`${n++}. ${r.action}`)
    md.push('')

    const version = prev ? `v${(Number(prev.version.replace(/^v/, '')) + 0.1).toFixed(1)}` : 'v1.0'

    const report = await this.prisma.debugReport.create({
      data: {
        projectId,
        title: `${project.name} 调试报告`,
        version,
        author: prev?.author ?? 'ZH',
        markdown: md.join('\n'),
        tocJson: toc as never,
        statsJson: stats as never,
      },
    })

    return {
      id: report.id,
      version,
      stats,
      sections: toc.filter((t) => t.level === 1).length,
      markdownBytes: report.markdown.length,
    }
  }

  async thread(projectId: string, mode: string) {
    const t = await this.prisma.aiThread.findFirst({ where: { projectId, mode } })
    return { mode, messages: Array.isArray(t?.messagesJson) ? t.messagesJson : [] }
  }
}
