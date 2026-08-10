/**
 * 签名算法对着厂商 demo 生成的 golden vector 逐条比对。
 *
 * 签名是唯一「错了就 401、但错在哪一步完全看不出来」的部分。
 * golden.json 是用手册 samples/ 里的 Python demo 原样算出来的 ——
 * 拿不到 API Key 也能验证我们这一侧写对了。
 */
import { describe, expect, it } from 'vitest'
import golden from './ezplm-signing-golden.json'
import { canonicalQuery, canonicalRequest, signRequest } from '../src/providers/ezplm-signing'

interface GoldenCase {
  key: string
  method: string
  path: string
  params: Record<string, string>
  ts: string
  nonce: string
  canonical: string
  signature: string
}

const cases = golden as GoldenCase[]

describe('ezPLM 签名（对厂商 demo 的 golden vector）', () => {
  it.each(cases.map((c, i) => [i, c] as const))('#%i canonical 串一致', (_i, c) => {
    expect(
      canonicalRequest({
        method: c.method,
        path: c.path,
        params: c.params,
        timestamp: c.ts,
        nonce: c.nonce,
      }),
    ).toBe(c.canonical)
  })

  it.each(cases.map((c, i) => [i, c] as const))('#%i 签名值一致', (_i, c) => {
    expect(
      signRequest({
        apiKey: c.key,
        method: c.method,
        path: c.path,
        params: c.params,
        timestamp: c.ts,
        nonce: c.nonce,
      }),
    ).toBe(c.signature)
  })
})

describe('canonicalQuery 的三条易错规则', () => {
  it('按 key 排序，与传入顺序无关', () => {
    // 传入顺序不同、签名必须一致，否则同一个请求写两遍会得到两个签名
    expect(canonicalQuery({ pageSize: '10', keyword: 'X' })).toBe(
      canonicalQuery({ keyword: 'X', pageSize: '10' }),
    )
    expect(canonicalQuery({ pageSize: '10', keyword: 'X' })).toBe('keyword=X&pageSize=10')
  })

  it('按字节序排，不是 localeCompare', () => {
    // JS demo 用 localeCompare，它把 'a' 排在 'A' 前面；PHP strcmp 与 Python
    // 的元组排序把 'A' 排前面。三份官方 demo 里 JS 是异类，服务端（PHP/Python/
    // Java 任一）都是字节序。今天的参数全是小写开头所以看不出差别，
    // 但加一个大写开头的参数那天就会 401，且没有任何线索。
    expect(canonicalQuery({ a: '2', A: '1' })).toBe('A=1&a=2')
    expect(canonicalQuery({ pageSize: '1', Cursor: 'x' })).toBe('Cursor=x&pageSize=1')
  })

  it('空值参数被剔除 —— cursor 为空时不能出现在串里', () => {
    expect(canonicalQuery({ keyword: 'X', cursor: '', pageSize: null })).toBe('keyword=X')
    expect(canonicalQuery({})).toBe('')
  })

  it('按 RFC 3986 转义，MPN 里的 / 会变成 %2F', () => {
    expect(canonicalQuery({ keyword: 'MCP4725A0T-E/CH' })).toBe('keyword=MCP4725A0T-E%2FCH')
  })

  it("!'()* 也转义（PHP/Python demo 的口径，JS demo 不转）", () => {
    // 三份官方 demo 在这里不一致，说明服务端要么宽容、要么真实参数里没这些字符。
    // 这条测试把选择钉住：真发现服务端只认 JS 那种，改 rfc3986 一处即可。
    expect(canonicalQuery({ q: "a(b)c!" })).toBe('q=a%28b%29c%21')
  })

  it('签名是 base64url 且无 padding', () => {
    const sig = signRequest({
      apiKey: 'k',
      method: 'GET',
      path: '/p',
      params: {},
      timestamp: '1',
      nonce: 'n',
    })
    expect(sig).not.toContain('=')
    expect(sig).not.toContain('+')
    expect(sig).not.toContain('/')
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
