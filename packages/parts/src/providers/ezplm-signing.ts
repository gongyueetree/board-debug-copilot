/**
 * ezPLM 的 API Key 签名。
 *
 * 单独一个文件、不碰网络，是为了能用厂商 demo 生成的 golden vector 逐条比对 ——
 * 签名算法是唯一「错了会 401、但错在哪一步完全看不出来」的部分，
 * 拿不到 API Key 也必须能验证它。
 *
 * 规则（手册 §1.1 + samples/ 三份 demo）：
 *   canonical = METHOD \n PATH \n 排序后的 query \n X-Timestamp \n X-Nonce
 *   X-Signature = base64url(HMAC-SHA256(APIKey, canonical))   // 无 padding
 *
 * 三个要点，错一个就 401 且没有额外线索：
 *   1. query 先按 key 排序、key 相同再按 value 排序，**签名与实际 URL 用同一份串**
 *   2. 空值参数要剔除（`cursor=''` 不参与签名，也不能出现在 URL 里）
 *   3. base64url 去掉尾部的 `=`
 */
import { createHmac } from 'node:crypto'

export interface SignInput {
  apiKey: string
  method: string
  path: string
  params: Record<string, string | number | undefined | null>
  timestamp: string
  nonce: string
}

/**
 * RFC 3986 百分号编码。
 *
 * `encodeURIComponent` 不编码 `!'()*`，而 PHP 的 `rawurlencode` 与 Python 的
 * `quote(safe='')` 会编码。三份官方 demo 在这一点上并不一致 —— 说明服务端要么
 * 宽容，要么真实参数里从来没出现过这几个字符。
 *
 * 这里跟 PHP/Python 走（三份里占两份，也是 RFC 3986 的严格形式）。
 * 万一将来发现服务端只认 JS 那种，把这个函数换掉即可，调用方一处不用动。
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * 字节序比较（等价于 PHP `strcmp` 与 Python 的元组排序）。
 *
 * **不用 `localeCompare`。** JS demo 用的是它，但它是 locale 相关的：
 * `'A'.localeCompare('a')` 返回 1（`a` 排前面），而 `strcmp` / Python 的
 * 字节序把 `A` 排前面。三份官方 demo 里 JS 是唯一的异类 —— PHP、Python
 * 以及任何 Java/Go 服务端都是字节序。
 *
 * 现有参数（cursor / keyword / pageSize / partlibId）全是小写开头，两种排法
 * 结果一样，所以这个差异今天不会发作。但它会在加一个大写开头的参数那天发作，
 * 而症状是 401 且没有任何线索。
 */
const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 规范化查询串。**签名和实际请求 URL 必须用同一份输出** ——
 * 分别构造是这类签名最常见的翻车点：本地怎么看都对，服务端就是 401。
 */
export function canonicalQuery(
  params: Record<string, string | number | undefined | null>,
): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => [String(k), String(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? byteCompare(a[1], b[1]) : byteCompare(a[0], b[0])))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&')
}

export function canonicalRequest(input: Omit<SignInput, 'apiKey'>): string {
  return [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.params),
    input.timestamp,
    input.nonce,
  ].join('\n')
}

export function signRequest(input: SignInput): string {
  return createHmac('sha256', input.apiKey)
    .update(canonicalRequest(input))
    .digest('base64url')
}
