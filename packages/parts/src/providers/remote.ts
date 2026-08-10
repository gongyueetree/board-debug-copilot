import { EZPLM_BASE_URL } from './ezplm'

/**
 * 接入信息的缺口清单。
 *
 * P9 写这个文件时九项一项都没有，所以 remote provider 直接不可用。
 * 现在 ezPLM 的手册与三份签名 demo 到位了，**九项里补上了五项**，
 * 剩下这几项仍然缺 —— 它们不阻塞接入，但会限制能力，所以要在 /health
 * 里显形，而不是等到匹配率上不去时才去猜原因。
 *
 * 判据很简单：**缺了会让我们编数据的，阻塞接入；缺了只是少一项能力的，不阻塞。**
 * 下面这几项属于后者，所以 provider 可用，但 capabilities 里对应位是 false。
 */
export const MISSING_SPEC = [
  'fields: 完整字段字典 —— 手册只列了 id/mpn/manufacturer/footprint/symbol/pdf/attributes 七个「最重要的字段」，没有类型、单位、可空性',
  'samples: 真实响应样例 —— 一条都没有。attributes 的内部结构因此是盲的，参数抽取率无法预估',
  'paging: meta 的字段名 —— 手册只说「data + meta 的分页结构」，没写游标叫什么',
  'rateLimit: 具体配额数字 —— 只知道按天计、超了 429，不知道每天多少次',
  'categories: 类目字典 —— ezPLM 根本不返回 category，只能从 mpn/描述推断',
] as const

/** 已经拿到的（留在这里是为了让「还缺什么」有对照） */
export const RESOLVED_SPEC = [
  'baseUrl: https://www.ezplm.cn',
  'auth: HMAC-SHA256，X-API-Key / X-Timestamp / X-Nonce / X-Signature，nonce 一次性',
  'endpoints: GET /api/v1/api-key/parts 与 GET /api/v1/api-key/reference-designs',
  'errorCodes: 400 参数或签名头缺失 / 401 签名错 / 404 partlibId 错 / 429 当天配额用尽',
  'pagingParams: cursor + pageSize（请求侧）',
] as const

export interface RemoteConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  batchSize: number
  maxConcurrency: number
}

export const DEFAULT_REMOTE_BASE_URL = EZPLM_BASE_URL

/** 分片。ezPLM 没有批量端点，这个留给将来接别的库用。 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 并发上限。
 *
 * ezPLM 的配额按天计而不是按 QPS，所以它的 batchGetByMpn 是**串行**的 ——
 * 并发只会更快烧完当天额度。这个函数留给按 QPS 限流的库。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}
