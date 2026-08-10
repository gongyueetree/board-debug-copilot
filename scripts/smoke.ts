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

const postJson = async (url: string, body: unknown, token?: string): Promise<any> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

/**
 * 鉴权检查之间要传递克隆出来的项目 id 与 token。
 *
 * 两个测试账号用固定邮箱，重复跑不会不断新建用户；但每跑一次会多一个克隆项目
 * （目前没有删除项目的接口）。CI 每次都是干净库，本地跑多了自己清一下。
 */
const smokeState: { mine?: string; tokenA?: string } = {}

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

/**
 * 写操作鉴权的运行时检查。
 *
 * apps/api/test/authorization.test.ts 挡的是「源码里漏了 guard」，跑得快但看不到
 * 真实 HTTP 行为。这里补上另一半：真登录、真克隆、真拿别人的项目去写。
 * 需要数据库，所以放在冒烟里而不是 vitest。
 */
const authChecks: Check[] = [
  {
    name: 'auth 未登录不能写公共 Demo',
    run: async () => {
      const res = await fetch(`${API}/api/v1/projects/${PROJECT}/debug-steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'smoke 不该写进去', groupTitle: 'smoke' }),
      })
      expect(res.status === 403, `期望 403，实得 ${res.status}`)
      return '403，公共 Demo 只读'
    },
  },
  {
    name: 'auth 未登录不能改公共 Demo 的步骤',
    run: async () => {
      // step id 不含项目信息，controller 必须先反查归属 —— 这里正是它漏过的地方
      const steps = await json(`${API}/api/v1/projects/${PROJECT}/debug-steps`)
      const id = steps.groups[0]?.steps[0]?.id
      expect(!!id, '拿不到任何 debug step')
      const res = await fetch(`${API}/api/v1/debug-steps/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      })
      expect(res.status === 403, `期望 403，实得 ${res.status}`)
      return '403，反查归属后被拒'
    },
  },
  {
    name: 'auth 登录 → 克隆 → 能写自己的项目',
    run: async () => {
      const { token } = await postJson(`${API}/api/v1/auth/login`, {
        email: 'smoke-owner@bdc.test',
      })
      const mine = await postJson(`${API}/api/v1/projects/${PROJECT}/clone`, {}, token)
      expect(!!mine.id, '克隆没有返回项目 id')

      const res = await fetch(`${API}/api/v1/projects/${mine.id}/debug-steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'smoke 自己的步骤', groupTitle: 'smoke' }),
      })
      expect(res.ok, `写自己的项目应成功，实得 ${res.status}`)
      smokeState.mine = mine.id
      smokeState.tokenA = token
      return `克隆为 ${mine.id.slice(0, 8)}…，写入成功`
    },
  },
  {
    name: 'auth 不能写别人的项目',
    run: async () => {
      expect(!!smokeState.mine, '上一步没有克隆出项目')
      const { token } = await postJson(`${API}/api/v1/auth/login`, {
        email: 'smoke-stranger@bdc.test',
      })
      const res = await fetch(`${API}/api/v1/projects/${smokeState.mine}/debug-steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: '别人的项目', groupTitle: 'smoke' }),
      })
      expect(res.status === 403, `期望 403，实得 ${res.status}`)
      return '403，他人项目不可写'
    },
  },
  {
    name: 'auth 捕获保存与报告生成都要鉴权',
    run: async () => {
      const results: string[] = []
      for (const [path, body] of [
        [`projects/${PROJECT}/captures`, { kind: 'SCOPE', label: 'smoke' }],
        [`projects/${PROJECT}/reports`, {}],
      ] as const) {
        const res = await fetch(`${API}/api/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(res.status === 403, `${path} 期望 403，实得 ${res.status}`)
        results.push(String(res.status))
      }
      return `captures/reports 均 ${results[0]}`
    },
  },
  {
    name: 'files objectKey 越界被拒',
    run: async () => {
      const bad = ['../../etc/passwd', 'etc/passwd', 'projects/../secret']
      for (const key of bad) {
        const res = await fetch(`${API}/api/v1/files/${encodeURIComponent(key)}`)
        expect(res.status === 403, `${key} 期望 403，实得 ${res.status}`)
      }
      return `${bad.length} 种越界 key 全部 403`
    },
  },
  {
    name: 'files 私有项目的对象需要 token',
    run: async () => {
      expect(!!smokeState.mine, '没有可用的私有项目')
      const key = `projects/${smokeState.mine}/kicad/whatever.zip`
      const anon = await fetch(`${API}/api/v1/files/${encodeURIComponent(key)}`)
      expect(anon.status === 403, `匿名读私有项目应 403，实得 ${anon.status}`)

      // 带上 token 后不再是权限问题，而是对象本身不存在
      const authed = await fetch(
        `${API}/api/v1/files/${encodeURIComponent(key)}?token=${smokeState.tokenA}`,
      )
      expect(authed.status === 404, `带 token 应因对象不存在而 404，实得 ${authed.status}`)
      return '匿名 403 / 有 token 404'
    },
  },
  {
    name: 'auth upload-fallback 不能写公共 Demo',
    run: async () => {
      // 这条路由是 mock 存储的直传回落。它能往任意 projects/<id>/ 下写文件，
      // 所以归属规则必须和业务写操作一模一样。
      const res = await fetch(`${API}/api/v1/files/upload-fallback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objectKey: `projects/${PROJECT}/kicad/smoke-should-fail.zip`,
          kind: 'zip',
          mimeType: 'application/zip',
          base64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
        }),
      })
      expect(res.status === 403, `期望 403，实得 ${res.status}`)
      return '403，公共 Demo 只读'
    },
  },
  {
    name: 'auth upload-fallback 不能写别人的项目',
    run: async () => {
      expect(!!smokeState.mine, '上一步没有克隆出项目')
      const { token } = await postJson(`${API}/api/v1/auth/login`, {
        email: 'smoke-stranger@bdc.test',
      })
      const res = await fetch(`${API}/api/v1/files/upload-fallback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          objectKey: `projects/${smokeState.mine}/kicad/stranger.zip`,
          kind: 'zip',
          mimeType: 'application/zip',
          base64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
        }),
      })
      expect(res.status === 403, `期望 403，实得 ${res.status}`)
      return '403，他人项目不可写'
    },
  },
  {
    name: 'auth upload-fallback 不存在的项目被拒',
    run: async () => {
      const res = await fetch(`${API}/api/v1/files/upload-fallback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          objectKey: 'projects/11111111-1111-1111-1111-111111111111/kicad/x.zip',
          kind: 'zip',
          mimeType: 'application/zip',
          base64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
        }),
      })
      // 放行的话就是「往任意 uuid 下写文件」
      expect(res.status === 404, `期望 404，实得 ${res.status}`)
      return '404，项目不存在'
    },
  },
  {
    name: 'storage 坏 MIME 与超限被拒',
    run: async () => {
      expect(!!smokeState.mine && !!smokeState.tokenA, '没有可写的项目')
      const auth = { authorization: `Bearer ${smokeState.tokenA}` }
      const bad = await fetch(`${API}/api/v1/files/upload-fallback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({
          objectKey: `projects/${smokeState.mine}/kicad/bad.zip`,
          kind: 'zip',
          mimeType: 'text/html',
          base64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',
        }),
      })
      expect(bad.status === 400, `坏 MIME 期望 400，实得 ${bad.status}`)

      const limits = await json(`${API}/api/v1/files/limits/all`)
      expect(limits.zip.maxBytes > 0, 'limits 没返回 zip 上限')
      return `坏 MIME 400，zip 上限 ${limits.zip.maxBytes / 1024 / 1024}MB`
    },
  },
  {
    name: 'storage presign 签的是确切大小',
    run: async () => {
      expect(!!smokeState.mine && !!smokeState.tokenA, '没有可写的项目')
      const pre = await postJson(
        `${API}/api/v1/projects/${smokeState.mine}/kicad/presign`,
        { filename: 'demo.zip', mimeType: 'application/zip', sizeBytes: 4096 },
        smokeState.tokenA,
      )
      expect(!!pre.objectKey, 'presign 没返回 objectKey')
      // mock 存储没有真直传，isFallback=true；s3 下 URL 里应能看到签名
      if (pre.isFallback) return 'mock 存储：回落到 base64（预期）'
      expect(decodeURIComponent(pre.url).includes('content-length'), 'content-length 没进签名')
      return 's3：content-length 已签进 URL'
    },
  },
  {
    name: 'health 报告存储状态',
    run: async () => {
      const d = await json(`${API}/health`)
      expect(!!d.storage, '/health 没有 storage 字段')
      expect(d.storage.productionUnsafe === false, '存储处于不可用于生产的状态')
      return `adapter=${d.storage.adapter} degraded=${d.storage.degraded}`
    },
  },
]

checks.push(...authChecks)

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
