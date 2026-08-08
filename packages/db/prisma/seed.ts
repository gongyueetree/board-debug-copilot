/**
 * Seed — Sensor Board Debug Demo
 *
 * 数值规格见 docs/02「Seed（必须实现）」与 docs/05 §11.1 / §16.1 / §16.2。
 * 幂等：先按 projectId 清空级联数据再重建，可反复执行。
 */
import { PrismaClient, type Prisma } from '@prisma/client'
import {
  CAPTURES,
  COMPONENTS,
  DEFAULT_SCENARIO,
  DIAGNOSIS,
  EARLY_CAPTURES,
  NETS,
  PHOTO_ID,
  PLAN_GROUPS,
  PROJECT_ID,
  REPORT_ID,
  TEST_POINTS,
  VIOLATIONS,
  VISUAL_FINDINGS,
} from './seed-data/demo.js'

const prisma = new PrismaClient()

const J = (v: unknown) => v as Prisma.InputJsonValue

async function main() {
  console.log('seed: Sensor Board Debug Demo')

  // AiDiagnosis 在 docs/02 的 schema 里只有 projectId 字段、没有到 Project 的关系，
  // 因此不会被级联删除；捕获被删时它的 captureId 只会被置空，留下孤儿行。
  // 必须显式先删，否则重复执行 seed 会让 AI 建议数翻倍。
  await prisma.aiDiagnosis.deleteMany({ where: { projectId: PROJECT_ID } })
  // 其余表由 onDelete: Cascade 覆盖
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } })

  const project = await prisma.project.create({
    data: {
      id: PROJECT_ID,
      name: 'Sensor Board Debug Demo',
      description:
        'AD8605 反相放大器（单电源 5V，Rin=10k, Rf=100k, 设计增益 -10）+ MCP4725 DAC + TPS7A02 LDO',
      status: 'READY',
      currentIssue: '输出无响应，Vout 一直为 0V',
    },
  })

  // ---- Nets ----
  const netIdByName = new Map<string, string>()
  for (const n of NETS) {
    const net = await prisma.net.create({
      data: {
        projectId: project.id,
        name: n.name,
        netClass: 'netClass' in n ? n.netClass : null,
        inferredRole: n.inferredRole,
        expectedVoltage: 'expectedVoltage' in n ? n.expectedVoltage : null,
        expectedFrequency: 'expectedFrequency' in n ? n.expectedFrequency : null,
      },
    })
    netIdByName.set(n.name, net.id)
  }
  console.log(`  nets: ${netIdByName.size}`)

  // ---- Components + Pins ----
  const compIdByRef = new Map<string, string>()
  let pinCount = 0
  for (const c of COMPONENTS) {
    const comp = await prisma.component.create({
      data: {
        projectId: project.id,
        ref: c.ref,
        value: c.value,
        symbol: 'symbol' in c ? c.symbol : null,
        footprint: c.footprint,
        partNumber: 'partNumber' in c ? c.partNumber : null,
        manufacturer: 'manufacturer' in c ? c.manufacturer : null,
        datasheetUrl: 'datasheetUrl' in c ? c.datasheetUrl : null,
        x: c.x,
        y: c.y,
        side: c.side,
        rawJson: J(c.rawJson),
      },
    })
    compIdByRef.set(c.ref, comp.id)

    for (const [number, name, type, netName] of c.pins) {
      await prisma.pin.create({
        data: {
          componentId: comp.id,
          number,
          name,
          type,
          netId: netName ? (netIdByName.get(netName) ?? null) : null,
        },
      })
      pinCount++
    }
  }
  console.log(`  components: ${compIdByRef.size}, pins: ${pinCount}`)

  // ---- TestPoints ----
  for (const tp of TEST_POINTS) {
    await prisma.testPoint.create({
      data: {
        projectId: project.id,
        netId: netIdByName.get(tp.net) ?? null,
        label: tp.label,
        description: tp.description,
        x: tp.x,
        y: tp.y,
        source: tp.source,
      },
    })
  }
  console.log(`  testPoints: ${TEST_POINTS.length}`)

  // ---- RuleViolations ----
  for (const v of VIOLATIONS) {
    await prisma.ruleViolation.create({
      data: {
        projectId: project.id,
        origin: v.origin,
        code: v.code,
        severity: v.severity,
        title: v.title,
        description: v.description,
        evidence: v.evidence.join('\n'),
        risk: v.risk,
        suggestion: v.suggestion,
        recommendedTest: v.recommendedTest ?? null,
        componentRef: v.componentRef ?? null,
        netName: v.netName ?? null,
        resolved: 'resolved' in v ? Boolean(v.resolved) : false,
      },
    })
  }
  const open = VIOLATIONS.filter((v) => !('resolved' in v && v.resolved))
  const bySeverity = open.reduce<Record<string, number>>((a, v) => {
    a[v.severity] = (a[v.severity] ?? 0) + 1
    return a
  }, {})
  console.log(
    `  violations: ${VIOLATIONS.length} 总数 / ${open.length} 未解决 (${JSON.stringify(bySeverity)})`,
  )

  // ---- DebugSteps（两层树）----
  const stepIdByTitle = new Map<string, string>()
  let stepCount = 0
  for (const [gi, group] of PLAN_GROUPS.entries()) {
    const parent = await prisma.debugStep.create({
      data: {
        projectId: project.id,
        order: gi + 1,
        title: group.title,
        status: group.steps.every((s) => s.status === 'COMPLETED') ? 'COMPLETED' : 'PENDING',
      },
    })
    for (const [si, s] of group.steps.entries()) {
      const step = await prisma.debugStep.create({
        data: {
          projectId: project.id,
          parentId: parent.id,
          order: si + 1,
          title: s.title,
          objective: s.objective,
          toolHint: s.tool,
          estimateMin: s.min,
          setupJson: 'setup' in s ? J(s.setup) : undefined,
          targetNet: 'targetNet' in s ? s.targetNet : null,
          targetComponent: 'targetComponent' in s ? s.targetComponent : null,
          expectedResult: s.expected,
          abnormalNext: s.abnormal.join('\n'),
          status: s.status,
          resultJson: 'result' in s ? J({ ...s.result, expectedValue: s.expectedValue }) : undefined,
        },
      })
      stepIdByTitle.set(`${gi + 1}.${si + 1}`, step.id)
      stepCount++
    }
  }
  console.log(`  debugSteps: ${PLAN_GROUPS.length} 组 / ${stepCount} 步`)

  // ---- Captures（3 条早期 + 5 个场景 = 8 条）----
  const vout = netIdByName.get('VOUT_AMP') ?? null
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000)

  for (const e of EARLY_CAPTURES) {
    await prisma.capture.create({
      data: {
        projectId: project.id,
        netId: netIdByName.get(e.net) ?? null,
        kind: e.kind,
        label: `#${e.no} ${e.label}`,
        createdAt: at(e.minutesAgo),
        hardwareSetupJson: J({ instrument: 'ADALM2000', mode: e.kind }),
        measurementsJson: J(e.measurements),
      },
    })
  }

  let defaultCaptureId = ''
  for (const c of CAPTURES) {
    const cap = await prisma.capture.create({
      data: {
        projectId: project.id,
        netId: vout,
        kind: 'OSCILLOSCOPE',
        label: `#${c.no} ${c.label}`,
        createdAt: at(c.minutesAgo),
        // 步骤 3.1 是本次调试的关键证据，把默认场景挂到它下面
        debugStepId: c.scenario === DEFAULT_SCENARIO ? (stepIdByTitle.get('3.1') ?? null) : null,
        hardwareSetupJson: J({
          scenario: c.scenario,
          instrument: 'ADALM2000',
          awg: [
            { channel: 'W2', target: 'J1 (VIN_SENS)', wave: 'sine', freqHz: 1000, amplitudeVpp: c.driveVpp, offsetV: 0 },
            { channel: 'W1', target: 'TP3 (VREF)', wave: 'dc', freqHz: 0, amplitudeVpp: 0, offsetV: 2.5, requiresConfirm: true },
          ],
          scope: {
            timebaseSPerDiv: 0.0005,
            sampleRate: 1_000_000,
            trigger: { source: 'CH1', edge: 'rising', levelV: 0 },
            channels: {
              CH1: { voltsPerDiv: 1, coupling: 'DC', probe: '1x', label: 'TP1 (IN)' },
              CH2: { voltsPerDiv: 2, coupling: 'DC', probe: '1x', label: 'TP2 (OUT)' },
            },
          },
        }),
        measurementsJson: J({
          ch1: c.ch1,
          ch2: c.ch2,
          gain: c.gain,
          gainDb: c.gainDb,
          phaseDeg: c.phaseDeg,
          phaseDeviationDeg: c.phaseDeviationDeg,
          note: '增益和相位基于基波（1.000 kHz）计算',
        }),
      },
    })
    if (c.scenario === DEFAULT_SCENARIO) defaultCaptureId = cap.id
  }
  console.log(
    `  captures: ${EARLY_CAPTURES.length + CAPTURES.length}（${CAPTURES.length} 个场景，默认 ${DEFAULT_SCENARIO} = #8）`,
  )

  // ---- AiDiagnosis（captureId 唯一，见 docs/05 §7.3）----
  await prisma.aiDiagnosis.create({
    data: {
      projectId: project.id,
      captureId: defaultCaptureId,
      severity: DIAGNOSIS.severity,
      rootCause: DIAGNOSIS.rootCause,
      confidence: DIAGNOSIS.confidence,
      evidenceJson: J(DIAGNOSIS.evidence),
      recommendationsJson: J(DIAGNOSIS.recommendations),
      rawJson: J({ alternativeCauses: DIAGNOSIS.alternativeCauses, intent: 'waveform_analyze' }),
    },
  })
  console.log('  aiDiagnosis: 1')

  // ---- BoardPhoto + VisualFindings + Annotations ----
  const photo = await prisma.boardPhoto.create({
    data: {
      id: PHOTO_ID,
      projectId: project.id,
      objectKey: 'mock/photos/sensor-board-top.jpg',
      side: 'TOP',
      alignmentJson: J({
        status: '对齐良好',
        boardOutline: {
          matched: 4,
          total: 4,
          corners: [
            { name: '左上角', errorMm: 0.35 },
            { name: '右上角', errorMm: 0.32 },
            { name: '右下角', errorMm: 0.28 },
            { name: '左下角', errorMm: 0.31 },
          ],
        },
        referencePoints: { matched: 3, total: 3, items: ['J1 定位孔', 'J3 定位孔', 'U1 1脚'] },
        componentMapping: { matchedPct: 98.2, matched: 112, total: 114, pending: 2, unknown: 0 },
      }),
    },
  })

  for (const f of VISUAL_FINDINGS) {
    await prisma.visualFinding.create({
      data: {
        photoId: photo.id,
        code: f.code,
        title: f.title,
        detail: f.detail,
        confidence: f.confidence,
        severity: f.severity,
        componentRef: f.componentRef,
      },
    })
    await prisma.photoAnnotation.create({
      data: {
        photoId: photo.id,
        componentId: compIdByRef.get(f.componentRef) ?? null,
        kind: f.certainty === 'CONFIRMED' ? 'component' : 'question',
        regionJson: J(f.region),
        note: f.title,
        createdBy: 'AI',
      },
    })
  }
  console.log(`  visualFindings: ${VISUAL_FINDINGS.length}, photoAnnotations: ${VISUAL_FINDINGS.length}`)

  // ---- DebugReport ----
  const toc = [
    { id: 'summary', title: '项目摘要', level: 1 },
    { id: 'summary-info', title: '项目信息', level: 2 },
    { id: 'summary-overview', title: '调试概览', level: 2 },
    { id: 'design', title: '设计审查', level: 1 },
    { id: 'design-ercdrc', title: 'ERC/DRC 结果', level: 2 },
    { id: 'design-advice', title: '设计建议', level: 2 },
    { id: 'photos', title: 'PCB 照片', level: 1 },
    { id: 'measurements', title: '测量数据', level: 1 },
    { id: 'diagnosis', title: 'AI 诊断', level: 1 },
    { id: 'process', title: '调试过程', level: 1 },
    { id: 'conclusion', title: '结论与建议', level: 1 },
  ]

  await prisma.debugReport.create({
    data: {
      id: REPORT_ID,
      projectId: project.id,
      title: '传感器采集板调试报告',
      version: 'v1.0',
      author: 'ZH',
      tocJson: J(toc),
      statsJson: J({ issues: 3, resolved: 2, improvements: 1, measurements: 8, aiSuggestions: 5 }),
      markdown: [
        '# 传感器采集板调试报告',
        '',
        '## 1 项目摘要',
        '',
        '本次调试共发现 3 个问题，其中 2 个已定位并提出修复建议，1 个为优化建议。',
        '',
        '| 项目名称 | Sensor Board Debug Demo |',
        '| --- | --- |',
        '| 电源方案 | +5V 输入，模拟供电 5V；LDO 输出 3.3V 供数字 |',
        '| 主要器件 | U1 AD8605 / U2 MCP4725 / U3 TPS7A02 |',
        '| 调试工具 | ADALM2000 |',
        '| 当前状态 | 问题定位完成 |',
        '',
        '## 2 设计审查',
        '',
        'ERC 错误 0，ERC 警告 3，DRC 违规 0。规则引擎与 AI 共输出 18 条发现，其中高风险 3 条。',
        '',
        '## 3 PCB 照片',
        '',
        '板框对齐 4/4，参考点 3/3，元器件映射 98.2%（112/114）。',
        '',
        '## 4 测量数据',
        '',
        '默认场景 gain_error：CH1 0.400 Vpp / CH2 2.002 Vpp / Gain 5.00 V/V / Phase −3.2° / THD+N 0.35%。',
        '',
        '## 5 AI 诊断',
        '',
        `根因：${DIAGNOSIS.rootCause}（置信度 ${DIAGNOSIS.confidence}）。`,
        '',
        '## 6 调试过程',
        '',
        '5 个分组共 22 步，已完成 9 步。',
        '',
        '## 7 结论与建议',
        '',
        '1. 补上 Vref 2.5V 偏置电路，解决输出无响应；',
        '2. 清除 R1/R2 焊锡桥接，恢复设计增益；',
        '3. 降低增益或提高供电余量，规避削顶风险。',
      ].join('\n'),
    },
  })
  console.log('  debugReport: 1')

  console.log('seed 完成')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
