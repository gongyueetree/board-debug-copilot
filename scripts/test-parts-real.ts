/**
 * ezPLM 真实接口联调。
 *
 *   PARTS_PROVIDER=remote PARTS_API_KEY=<key> pnpm test:parts-real
 *
 * 没配 PARTS_API_KEY 就 SKIPPED 并退 0 —— CI 不该消耗真实配额，
 * 而 ezPLM 的配额是**按天**算的（手册 §5：429 = 当天次数用完），
 * 跑一次 CI 就少一天的额度。
 *
 * 这个脚本只发 4~5 个请求，把「签名对不对、字段长什么样、参数抽得出来吗」
 * 这三件事一次问清楚。特别是 attributes 的结构 —— 手册没给样例，
 * 这是唯一能看清它的办法。
 */
import {
  EzplmPartsProvider,
  EZPLM_BASE_URL,
  PartsService,
  extractParams,
  guessCategoryFromRef,
  paramCompleteness,
  PartsError,
} from '@app/parts'
import { inferCategory } from '@app/parts'

const KEYWORD = process.env.PARTS_TEST_KEYWORD ?? 'TPS79301DBVR'

const line = (s = '') => console.log(s)

async function main() {
  const apiKey = process.env.PARTS_API_KEY
  line('ezPLM 真实接口联调')

  if (!apiKey) {
    line('  SKIPPED  未设置 PARTS_API_KEY')
    line('           PARTS_PROVIDER=remote PARTS_API_KEY=<key> pnpm test:parts-real')
    line('           接入契约与剩余缺口见 docs/11-parts-database.md')
    process.exit(0)
  }

  const baseUrl = (process.env.PARTS_API_BASE_URL || EZPLM_BASE_URL).replace(/\/$/, '')
  const provider = new EzplmPartsProvider({
    baseUrl,
    apiKey,
    timeoutMs: Number(process.env.PARTS_TIMEOUT_MS) || 15_000,
    pageSize: 10,
  })

  line(`  endpoint ${baseUrl}`)
  line(`  keyword  ${KEYWORD}\n`)

  let failed = 0
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      line(`  ✓ ${name.padEnd(34)} ${await fn()}`)
    } catch (err) {
      failed++
      const msg = err instanceof PartsError ? `[${err.code}] ${err.message}` : String(err)
      line(`  ✗ ${name.padEnd(34)} ${msg}`)
    }
  }

  let firstId: string | null = null
  let sample: Record<string, unknown> | null = null

  await check('签名通过 + 关键词搜索', async () => {
    const hits = await provider.searchByKeyword(KEYWORD, { limit: 10 })
    if (hits.length === 0) {
      throw new Error('返回空列表：确认关键词，以及该供应商是否在白名单里')
    }
    sample = hits[0] as Record<string, unknown>
    firstId = typeof sample.id === 'string' ? sample.id : null
    return `${hits.length} 条，首条 mpn=${String(sample.mpn)}`
  })

  await check('按 MPN 精确筛选', async () => {
    const hit = await provider.getByMpn(KEYWORD)
    return hit ? `命中 ${String((hit as Record<string, unknown>).mpn)}` : '无精确匹配（会走 L2 前缀）'
  })

  await check('参考设计', async () => {
    if (!firstId) throw new Error('上一步没拿到 id')
    const refs = await provider.getReferenceDesigns(firstId, 10)
    return refs.length === 0 ? '该物料无关联参考设计' : `${refs.length} 条：${refs[0]?.name ?? ''}`
  })

  await check('端到端：PartsService 归一化', async () => {
    const svc = new PartsService({ env: { PARTS_PROVIDER: 'remote', PARTS_API_KEY: apiKey } as NodeJS.ProcessEnv })
    const part = await svc.getByMpn(KEYWORD)
    if (!part) return '未命中（不是错误：可能不在白名单）'
    const { got, want } = paramCompleteness(part.category, part.params)
    return `category=${part.category} 参数 ${got}/${want} 完整=${part.params.__meta?.complete}`
  })

  // ── 这一段才是跑这个脚本的主要目的 ──────────────────────────
  if (sample) {
    line('\n  ── 真实响应的字段结构（手册没给样例，这里打出来）──')
    for (const [k, v] of Object.entries(sample)) {
      const t = Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v
      const preview =
        typeof v === 'object' && v !== null
          ? JSON.stringify(v).slice(0, 160)
          : String(v).slice(0, 80)
      line(`    ${k.padEnd(16)} ${t.padEnd(10)} ${preview}`)
    }

    const attrs = sample.attributes
    line('\n  ── attributes 结构判定 ──')
    if (Array.isArray(attrs)) {
      line(`    数组形状，${attrs.length} 项，首项：${JSON.stringify(attrs[0])}`)
    } else if (attrs && typeof attrs === 'object') {
      const keys = Object.keys(attrs as object)
      line(`    对象形状，${keys.length} 个键：${keys.slice(0, 12).join(', ')}`)
    } else {
      line(`    既不是数组也不是对象（${typeof attrs}）—— field-map 需要按实际结构调整`)
    }

    const cat = inferCategory({
      mpn: String(sample.mpn ?? ''),
      description: typeof sample.description === 'string' ? sample.description : undefined,
      symbol: typeof sample.symbol === 'string' ? sample.symbol : undefined,
    })
    const bag = extractParams(cat, (attrs as Record<string, unknown>) ?? {}, 'ezplm@probe')
    const { got, want } = paramCompleteness(cat, bag)
    line(`\n  推断类目 ${cat}（ezPLM 不返回 category），参数抽取 ${got}/${want}`)
    if (bag.__meta?.missing.length) line(`  缺：${bag.__meta.missing.join(', ')}`)
    void guessCategoryFromRef
  }

  line(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  line('把上面的字段结构填进 docs/11 §2，并据此调整 mapping/field-map.ts')
  process.exit(failed > 0 ? 1 : 0)
}

void main()
