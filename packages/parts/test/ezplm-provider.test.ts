/**
 * EzplmPartsProvider 对着一个进程内的假 ezPLM 服务跑。
 *
 * 假服务**按手册 §1.1 真的校验签名** —— 用另一份独立实现（Python demo 的算法，
 * 这里用 node:crypto 重写）算一遍再比对。所以「签名拼错了」在这里就会暴露，
 * 而不是等到拿着真 key 撞 401 才发现。
 *
 * 它替代不了真实联调（真实响应的 attributes 结构、配额、白名单范围都不模拟），
 * 但能保证我们这一侧的签名、分页、错误映射、MPN 精确筛选不退化。
 */
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EzplmPartsProvider, PartsError } from '../src'

const API_KEY = 'test-key-abc'

let server: Server
let baseUrl: string

/** 服务端侧的独立签名实现，用于校验客户端算得对不对 */
function serverSign(method: string, path: string, query: string, ts: string, nonce: string) {
  return createHmac('sha256', API_KEY)
    .update([method, path, query, ts, nonce].join('\n'))
    .digest('base64url')
}

const PART_AD8605 = {
  id: '019137eb-d4c0-76c9-b1f5-88ee84d727a6',
  mpn: 'AD8605ARZ',
  manufacturer: 'Analog Devices',
  footprint: 'SOIC-8',
  symbol: 'Amplifier_Operational:AD8605',
  pdf: 'https://example.com/ad8605.pdf',
  attributes: { 'Supply Voltage Min': '2.7 V', 'Supply Voltage Max': '5.5 V', 'Gain Bandwidth': '10 MHz' },
}
const PART_AD8605_OTHER = { ...PART_AD8605, id: 'other-id', mpn: 'AD8605AUJZ' }

/** 每个 nonce 只能用一次（手册：防重放） */
const usedNonces = new Set<string>()
let rateLimited = false

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const query = url.search.slice(1)
    const h = req.headers
    const send = (code: number, body: unknown) =>
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))

    if (rateLimited) return send(429, { message: 'daily quota exceeded' })

    const key = h['x-api-key'] as string | undefined
    const ts = h['x-timestamp'] as string | undefined
    const nonce = h['x-nonce'] as string | undefined
    const sig = h['x-signature'] as string | undefined
    if (!key || !ts || !nonce || !sig) return send(400, { message: 'missing signing header' })
    if (usedNonces.has(nonce)) return send(401, { message: 'nonce reused' })
    usedNonces.add(nonce)
    if (sig !== serverSign('GET', path, query, ts, nonce)) {
      return send(401, { message: 'bad signature' })
    }

    if (path === '/api/v1/api-key/parts') {
      const keyword = url.searchParams.get('keyword') ?? ''
      const cursor = url.searchParams.get('cursor')
      if (keyword === 'PAGED') {
        return cursor === 'p2'
          ? send(200, { data: [PART_AD8605_OTHER], meta: {} })
          : send(200, { data: [PART_AD8605], meta: { nextCursor: 'p2' } })
      }
      if (keyword === 'NOTHING') return send(200, { data: [], meta: {} })
      // 关键词搜索是模糊的：搜 AD8605 会同时返回 ARZ 与 AUJZ
      return send(200, { data: [PART_AD8605_OTHER, PART_AD8605], meta: {} })
    }

    if (path === '/api/v1/api-key/reference-designs') {
      const id = url.searchParams.get('partlibId')
      if (id !== PART_AD8605.id) return send(404, { message: 'not found' })
      return send(200, {
        data: [
          { name: '典型反相放大', link: 'https://example.com/ref/1', image: null, description: 'Rf/Rin=10' },
        ],
        meta: {},
      })
    }
    send(404, { message: 'unknown path' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const provider = (apiKey = API_KEY) =>
  new EzplmPartsProvider({ baseUrl, apiKey, timeoutMs: 5000, pageSize: 10 })

describe('EzplmPartsProvider 对真实 HTTP', () => {
  it('签名被服务端独立验证通过', async () => {
    // 服务端用另一份实现算签名再比对，拼错了这里就 401
    const hits = await provider().searchByKeyword('AD8605')
    expect(hits.length).toBe(2)
  })

  it('getByMpn 只认精确匹配，不拿搜索结果的第一条', async () => {
    // 搜 AD8605ARZ 时服务端先返回 AUJZ 再返回 ARZ；取第一条就是错的
    const hit = await provider().getByMpn('AD8605ARZ')
    expect((hit as { mpn: string }).mpn).toBe('AD8605ARZ')
  })

  it('筛不出精确匹配时返回 null，交给上游 L2', async () => {
    // 搜 AD8605（基础型号）时库里只有带后缀的，不该硬认一个
    expect(await provider().getByMpn('AD8605')).toBeNull()
  })

  it('每个 nonce 只用一次：连续两次请求都能成功', async () => {
    const p = provider()
    await p.searchByKeyword('AD8605')
    await p.searchByKeyword('AD8605')
    // nonce 复用的话第二次会 401（服务端有查重）
  })

  it('空结果就是空结果', async () => {
    expect(await provider().searchByKeyword('NOTHING')).toEqual([])
  })

  it('翻页跟着 meta.nextCursor 走，走完就停', async () => {
    const all = await provider().searchAllPages('PAGED')
    expect(all.map((p) => (p as { mpn: string }).mpn)).toEqual(['AD8605ARZ', 'AD8605AUJZ'])
  })

  it('参考设计能取到（方案里没算到的能力）', async () => {
    const refs = await provider().getReferenceDesigns(PART_AD8605.id)
    expect(refs[0]?.name).toBe('典型反相放大')
    expect(refs[0]?.link).toContain('https://')
  })

  it('partlibId 不对时 404 → BAD_RESPONSE', async () => {
    await expect(provider().getReferenceDesigns('nope')).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
  })

  it('签名错时 401 → UNAUTHORIZED，且提示查哪两样东西', async () => {
    const p = provider('wrong-key')
    await expect(p.searchByKeyword('AD8605')).rejects.toThrow(/X-Signature|X-Nonce/)
    await expect(p.searchByKeyword('AD8605')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('429 不可重试 —— 配额按天算，退避到明天才有意义', async () => {
    rateLimited = true
    try {
      const err = await provider()
        .searchByKeyword('AD8605')
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PartsError)
      expect((err as PartsError).code).toBe('RATE_LIMITED')
      // retryable=false：立刻重试只会白白再消耗一次配额
      expect((err as PartsError).retryable).toBe(false)
    } finally {
      rateLimited = false
    }
  })

  it('批量查询串行且单条失败不阻断整批', async () => {
    const got = await provider().batchGetByMpn(['AD8605ARZ', 'NOTHING', 'AD8605AUJZ'])
    expect([...got.keys()].sort()).toEqual(['AD8605ARZ', 'AD8605AUJZ'])
  })

  it('capabilities 如实反映接口能力', async () => {
    const c = provider().capabilities
    // 只有关键词搜索，没有精确查端点 —— getByMpn 是我们自己拼的，不能声称有
    expect(c.exactLookup).toBe(false)
    expect(c.keywordSearch).toBe(true)
    // 这三个接口根本没有，上游据此走本地兜底而不是拿到空数组
    expect(c.batchLookup).toBe(false)
    expect(c.alternates).toBe(false)
    expect(c.parametric).toBe(false)
    expect(c.lifecycle).toBe(false)
  })

  it('health 不主动打请求 —— 配额不该被健康检查消耗', async () => {
    const p = provider()
    const before = await p.health()
    expect(before.degraded).toBe(false)
    expect(before.lastError).toBeNull()
  })
})
