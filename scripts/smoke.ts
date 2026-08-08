/**
 * 冒烟检查：依次请求全部 API 端点与页面 SSR，校验关键内容确实渲染出来。
 *
 * 用法：
 *   pnpm smoke                                  本地（api :3001 / web :3000）
 *   API=https://... WEB=https://... pnpm smoke  生产
 *   BRIDGE=http://127.0.0.1:3777 pnpm smoke     一并检查本地 Bridge
 */
const API = (process.env.API ?? 'http://localhost:3001').replace(/\/$/, '')
const WEB = (process.env.WEB ?? 'http://localhost:3000').replace(/\/$/, '')
const BRIDGE = process.env.BRIDGE?.replace(/\/$/, '')
const PROJECT = process.env.PROJECT ?? '00000000-0000-0000-0000-0000000000d1'

interface Check {
  name: string
  run: () => Promise<string>
}

const json = async (url: string): Promise<any> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const html = async (url: string): Promise<string> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

const expect = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg)
}

const checks: Check[] = [
  {
    name: 'api /health',
    run: async () => {
      const d = await json(`${API}/health`)
      expect(d.status === 'ok', `status=${d.status}`)
      return `mock=${d.mockMode}`
    },
  },
  {
    name: 'api /projects',
    run: async () => {
      const d = await json(`${API}/api/v1/projects`)
      expect(d.length > 0, '项目列表为空')
      return `${d.length} 个项目`
    },
  },
  {
    name: 'api /projects/:id',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}`)
      expect(d.stats.components > 0, '组件数为 0')
      return `${d.stats.components} 组件 / ${d.stats.openViolations} 未解决风险`
    },
  },
  {
    name: 'api /design',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/design`)
      expect(d.nets.length > 0, '网络为空')
      return `${d.components.length} 组件 / ${d.nets.length} 网络 / ${d.violations.length} 违规`
    },
  },
  {
    name: 'api /captures',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/captures`)
      const scope = d.filter((c: any) => c.measurements)
      expect(scope.length >= 5, `示波器捕获只有 ${scope.length} 条`)
      return `${d.length} 条（示波器 ${scope.length}）`
    },
  },
  {
    name: 'api /debug-steps',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/debug-steps`)
      expect(d.totalSteps >= 20, `步骤只有 ${d.totalSteps}`)
      return `${d.groups.length} 组 / ${d.totalSteps} 步`
    },
  },
  {
    name: 'api /photos',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/photos`)
      expect(d[0]?.findings.length > 0, '视觉发现为空')
      return `${d.length} 张 / ${d[0].findings.length} 条视觉发现`
    },
  },
  {
    name: 'api /activity',
    run: async () => `${(await json(`${API}/api/v1/projects/${PROJECT}/activity`)).length} 条记录`,
  },
  {
    name: 'api /diagnoses/latest',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/diagnoses/latest`)
      expect(d.evidence.length > 0, '诊断无证据')
      return `置信度 ${d.confidence}，${d.recommendations.length} 条建议`
    },
  },
  {
    name: 'api /reports/latest',
    run: async () => {
      const d = await json(`${API}/api/v1/projects/${PROJECT}/reports/latest`)
      expect(d.markdown.length > 100, '报告正文过短')
      return `${d.title} ${d.version}`
    },
  },
  {
    name: 'api POST /ai/design-review（规则引擎）',
    run: async () => {
      const res = await fetch(`${API}/api/v1/ai/design-review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: PROJECT }),
      })
      expect(res.ok, `HTTP ${res.status}`)
      const d = await res.json()
      const codes = d.findings.map((f: any) => f.code)
      expect(
        codes.includes('SUPPLY_HEADROOM_INSUFFICIENT'),
        '未检出 SUPPLY_HEADROOM_INSUFFICIENT',
      )
      expect(codes.includes('OUTPUT_SWING_CLIPPING_RISK'), '未检出 OUTPUT_SWING_CLIPPING_RISK')
      return `${d.findings.length} 条发现，含两条关键设计缺陷`
    },
  },
  {
    name: 'api POST /ai/chat（SSE）',
    run: async () => {
      const res = await fetch(`${API}/api/v1/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: PROJECT, message: '主要风险是什么', mode: 'design_review' }),
      })
      expect(res.ok, `HTTP ${res.status}`)
      const text = await res.text()
      expect(text.includes('event: meta'), '缺少 meta 事件')
      expect(text.includes('event: narration'), '缺少 narration 事件')
      return `收到 ${text.split('event:').length - 1} 个 SSE 事件`
    },
  },
]

const PAGES: [string, string, string[]][] = [
  ['总览', '', ['工程解析完成', 'AI 调试参谋', '高风险问题', '最近调试记录']],
  ['设计审查', '/design', ['组件与筛选', 'AI 设计审查', 'BOM 风险概览']],
  ['调试工作台', '/bench', ['调试工作台']],
  ['PCB 照片', '/photos', ['PCB 实物照片', 'AI 视觉检测结果', '对齐与映射状态']],
  ['调试计划', '/plan', ['调试流程', '步骤详情', '问题描述']],
  ['测试报告', '/report', ['报告目录', '导出选项', 'AI 报告摘要']],
]

for (const [name, path, needles] of PAGES) {
  checks.push({
    name: `web 页面：${name}`,
    run: async () => {
      const body = await html(`${WEB}/projects/${PROJECT}${path}`)
      const missing = needles.filter((n) => !body.includes(n))
      expect(missing.length === 0, `缺少内容：${missing.join('、')}`)
      return `${needles.length} 项关键内容全部渲染`
    },
  })
}

if (BRIDGE) {
  checks.push(
    {
      name: 'bridge /status',
      run: async () => {
        const d = await json(`${BRIDGE}/status`)
        expect(d.connected, 'Bridge 未连接')
        return `${d.device} scenario=${d.scenario} mock=${d.mock}`
      },
    },
    {
      name: 'bridge 危险操作拦截',
      run: async () => {
        const res = await fetch(`${BRIDGE}/awg`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: 'W1', wave: 'dc', freqHz: 0, amplitudeVpp: 0, offsetV: 2.5 }),
        })
        expect(res.status === 428, `期望 428，实得 ${res.status}`)
        return '未确认的偏置输出被正确拒绝'
      },
    },
  )
}

async function main() {
  let failed = 0
  console.log(`冒烟检查\n  API    ${API}\n  WEB    ${WEB}${BRIDGE ? `\n  BRIDGE ${BRIDGE}` : ''}\n`)

  for (const c of checks) {
    try {
      const detail = await c.run()
      console.log(`  ✓ ${c.name.padEnd(34)} ${detail}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${c.name.padEnd(34)} ${(err as Error).message}`)
    }
  }

  console.log(`\n${checks.length - failed}/${checks.length} 通过`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
