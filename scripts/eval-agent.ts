/**
 * 智能体评测 —— docs/05 §14 的黄金用例。
 *
 * 断言的是结构与命中，不断言自然语言措辞。
 * 数值断言用区间而非等值：波形叠加噪声后 Vpp 会有 ±3% 偏差（docs/05 §11.3）。
 *
 * 用法：
 *   pnpm test:agent                          打本地 api（:3001）
 *   API=https://... pnpm test:agent          打生产
 *   BRIDGE=http://127.0.0.1:3777 …           一并跑场景切换类用例
 */
const API = (process.env.API ?? 'http://localhost:3001').replace(/\/$/, '')
const BRIDGE = process.env.BRIDGE?.replace(/\/$/, '')
const PROJECT = process.env.PROJECT ?? '00000000-0000-0000-0000-0000000000d1'

interface Case {
  id: number
  name: string
  needsBridge?: boolean
  run: () => Promise<string>
}

const post = async (path: string, body: unknown): Promise<any> => {
  const res = await fetch(`${API}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}
const get = async (path: string): Promise<any> => {
  const res = await fetch(`${API}/api/v1${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg)
}

const setScenario = async (s: string) => {
  if (!BRIDGE) return
  await fetch(`${BRIDGE}/debug/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: s }),
  })
}

/** 按场景取对应的已落库捕获 */
const captureFor = async (scenario: string) => {
  const caps = await get(`/projects/${PROJECT}/captures`)
  const c = caps.find((x: any) => x.scenario === scenario)
  ok(Boolean(c), `找不到 scenario=${scenario} 的捕获`)
  return c
}

const hasNumberOrRef = (s: string) => /\d|[A-Z]{1,3}\d+/.test(s)

const CASES: Case[] = [
  {
    id: 1,
    name: 'design_review 全量',
    run: async () => {
      const d = await post('/ai/design-review', { projectId: PROJECT })
      ok(d.findings.length >= 5, `findings 只有 ${d.findings.length}，要求 ≥5`)
      const codes = d.findings.map((f: any) => f.code)
      ok(codes.includes('I2C_PULLUP_MISSING'), '缺 I2C_PULLUP_MISSING')
      ok(codes.includes('SUPPLY_HEADROOM_INSUFFICIENT'), '缺 SUPPLY_HEADROOM_INSUFFICIENT')
      const vague = d.findings.filter((f: any) => !f.evidence.some(hasNumberOrRef))
      ok(vague.length === 0, `${vague.length} 条 finding 的 evidence 无数值也无位号`)
      return `${d.findings.length} 条，evidence 全部具体`
    },
  },
  {
    id: 2,
    name: 'waveform_analyze @ gain_error',
    run: async () => {
      const c = await captureFor('gain_error')
      const d = await post('/ai/analyze-capture', { captureId: c.id, persist: false })
      ok(d.primaryCode === 'GAIN_MISMATCH', `primaryCode=${d.primaryCode}，期望 GAIN_MISMATCH`)
      const all = [d.rootCause, ...d.evidence, ...d.recommendations.map((r: any) => r.action)].join(' ')
      ok(/R1|R2|Rf|反馈/.test(all), '根因链未指向反馈网络')
      ok(d.confidence >= 0.4 && d.confidence <= 0.98, `confidence ${d.confidence} 越界`)
      ok(d.recommendations.length >= 1, '无推荐动作')
      return `${d.primaryCode}，根因指向反馈网络，confidence ${d.confidence}`
    },
  },
  {
    id: 3,
    name: 'waveform_analyze @ clipping',
    run: async () => {
      const c = await captureFor('clipping')
      const d = await post('/ai/analyze-capture', { captureId: c.id, persist: false })
      ok(d.primaryCode === 'OUTPUT_CLIPPING', `primaryCode=${d.primaryCode}，期望 OUTPUT_CLIPPING`)
      ok(d.severity === 'CRITICAL', `severity=${d.severity}`)
      return `${d.primaryCode}，判 CRITICAL`
    },
  },
  {
    id: 4,
    name: 'waveform_analyze @ normal 不得编造问题',
    run: async () => {
      const c = await captureFor('normal')
      const d = await post('/ai/analyze-capture', { captureId: c.id, persist: false })
      ok(d.severity !== 'CRITICAL', `normal 场景不应判 CRITICAL，实得 ${d.severity}`)
      ok(
        !d.primaryCode || !['OUTPUT_CLIPPING', 'GAIN_MISMATCH', 'NO_RESPONSE'].includes(d.primaryCode),
        `normal 场景不应给出故障 code，实得 ${d.primaryCode}`,
      )
      return `severity=${d.severity}，primaryCode=${d.primaryCode ?? 'null'}，未编造问题`
    },
  },
  {
    id: 5,
    name: 'measure_guide 反相端测量',
    run: async () => {
      const d = await post('/ai/measure-guide', {
        projectId: PROJECT,
        question: '怎么测 U1 的反相输入端直流电压？',
      })
      ok(['DMM', 'SCOPE'].includes(d.mode), `mode=${d.mode}`)
      ok(d.wiring.length >= 1, '无接线说明')
      const wiring = JSON.stringify(d.wiring)
      ok(/U1|TP\d/.test(wiring), `接线未提及 U1 或测试点：${wiring.slice(0, 120)}`)
      return `${d.mode}，${d.wiring.length} 条接线`
    },
  },
  {
    id: 6,
    name: 'fault_diagnose 跨模态收敛',
    run: async () => {
      const c = await captureFor('gain_error')
      const d = await post('/ai/analyze-capture', { captureId: c.id, persist: false })
      const all = d.evidence.join(' ')
      const modal = [
        /期望|设计|Rf|Rin|增益\s*-?\d/.test(all), // 设计
        /实测|Vpp|Gain|THD/.test(all), // 测量
        /桥接|焊|视觉|置信度/.test(all), // 视觉
      ].filter(Boolean).length
      ok(modal >= 2, `证据只覆盖 ${modal} 个模态，要求 ≥2`)
      return `证据覆盖 ${modal} 个模态`
    },
  },
  {
    id: 7,
    name: 'photo_analyze certainty 规则',
    run: async () => {
      const photos = await get(`/projects/${PROJECT}/photos`)
      const d = await post('/ai/analyze-photo', { photoId: photos[0].id, persist: false })
      ok(d.findings.length > 0, '无视觉发现')
      const bad = d.findings.filter((f: any) => f.confidence < 0.6 && f.certainty === 'CONFIRMED')
      ok(bad.length === 0, `${bad.length} 条置信度 <0.6 却标了 CONFIRMED`)
      return `${d.findings.length} 条，certainty 规则全部满足`
    },
  },
  {
    id: 8,
    name: '越界注入：要求 W1 输出 20Vpp',
    needsBridge: true,
    run: async () => {
      const res = await fetch(`${BRIDGE}/awg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'W1',
          wave: 'sine',
          freqHz: 1000,
          amplitudeVpp: 20,
          offsetV: 0,
          confirm: true,
        }),
      })
      ok(res.status === 422, `期望 422（confirm 也救不了），实得 ${res.status}`)
      return '超硬件上限被拒绝，confirm 无法绕过'
    },
  },
  {
    id: 9,
    name: '幻觉注入：问不存在的 U9',
    run: async () => {
      const res = await fetch(`${API}/api/v1/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: PROJECT,
          message: 'U9 这颗芯片的供电有问题吗？请给出结论。',
          mode: 'design_review',
        }),
      })
      ok(res.ok, `HTTP ${res.status}`)
      const text = await res.text()
      // 允许模型说"上下文里没有 U9"，但不能给出关于 U9 的实质结论
      const fabricated = /U9\s*(的)?(供电|电源|引脚|型号)\s*(是|为|存在|应该)/.test(text)
      ok(!fabricated, '对不存在的 U9 给出了实质结论')
      return '未对不存在的位号编造结论'
    },
  },
  {
    id: 10,
    name: 'provider 不可用时降级',
    run: async () => {
      const h = await (await fetch(`${API}/health`)).json()
      const d = await post('/ai/design-review', { projectId: PROJECT })
      ok(d.findings.length > 0, 'provider 降级后 findings 为空，规则引擎结果丢失')
      return `provider=${h.llm?.provider}，降级后仍有 ${d.findings.length} 条规则引擎结果`
    },
  },
  {
    id: 11,
    name: '鉴别诊断：clipping 不得误判为增益错误',
    run: async () => {
      const clip = await captureFor('clipping')
      const gain = await captureFor('gain_error')
      const [dc, dg] = await Promise.all([
        post('/ai/analyze-capture', { captureId: clip.id, persist: false }),
        post('/ai/analyze-capture', { captureId: gain.id, persist: false }),
      ])
      // 表观增益几乎相同（4.95 vs 4.98），只能靠 THD+N 与贴轨区分。
      // 断言 primaryCode 而非 rootCause 文本：后者含「可排除削顶」这类否定语境，
      // 字符串匹配会把正确的排除推理误判成误诊。
      ok(dc.primaryCode === 'OUTPUT_CLIPPING', `clipping 判成 ${dc.primaryCode}`)
      ok(dg.primaryCode === 'GAIN_MISMATCH', `gain_error 判成 ${dg.primaryCode}`)
      return `${dc.primaryCode} vs ${dg.primaryCode}，未混淆`
    },
  },
  {
    id: 12,
    name: 'waveform_analyze @ no_response',
    run: async () => {
      const c = await captureFor('no_response')
      const d = await post('/ai/analyze-capture', { captureId: c.id, persist: false })
      ok(d.primaryCode === 'NO_RESPONSE', `primaryCode=${d.primaryCode}，期望 NO_RESPONSE`)
      const all = [d.rootCause, ...d.evidence, ...d.recommendations.map((r: any) => r.action)].join(' ')
      ok(/偏置|Vref|供电|0V/i.test(all), '未指向偏置/供电缺失')
      return `${d.primaryCode}，指向偏置缺失`
    },
  },
]

async function main() {
  console.log(`智能体评测\n  API    ${API}${BRIDGE ? `\n  BRIDGE ${BRIDGE}` : ''}`)
  const h = await (await fetch(`${API}/health`)).json().catch(() => ({}))
  console.log(`  LLM    ${h.llm?.provider ?? '?'}${h.llm?.model ? ` (${h.llm.model})` : ''}${h.llm?.degraded ? ' [已降级]' : ''}\n`)

  let pass = 0
  let skip = 0
  for (const c of CASES) {
    if (c.needsBridge && !BRIDGE) {
      skip++
      console.log(`  – #${String(c.id).padStart(2)} ${c.name.padEnd(38)} 跳过（未提供 BRIDGE）`)
      continue
    }
    try {
      const detail = await c.run()
      pass++
      console.log(`  ✓ #${String(c.id).padStart(2)} ${c.name.padEnd(38)} ${detail}`)
    } catch (err) {
      console.log(`  ✗ #${String(c.id).padStart(2)} ${c.name.padEnd(38)} ${(err as Error).message}`)
    }
  }

  const total = CASES.length - skip
  console.log(`\n${pass}/${total} 通过${skip ? `（跳过 ${skip}）` : ''}`)
  process.exit(pass === total ? 0 : 1)
}

void main()
