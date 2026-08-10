import type { NormalizedPart, PartLifecycle, RawPart } from '../types'
import { inferCategory, mapCategory } from './category-map'
import { normalizePackage } from './unit'
import { normalizeMpn } from '../normalize/mpn'
import { extractParams } from '../normalize/params'

/**
 * ★ 远端字段 → NormalizedPart。
 *
 * ezPLM 手册 §2「返回结果中最重要的字段」明确列了这几个：
 *   id / mpn / manufacturer / footprint / symbol / pdf / attributes
 *
 * 手册没有给完整字段字典，也没有响应样例，所以：
 *   - 明确列出的字段按手册写死（第一个候选就是手册里的名字）
 *   - 其余保留常见别名做兜底，命中不了就是 undefined，不编
 *   - **没有 category 字段** —— ezPLM 不返回类目，只能从 mpn/description 推断，
 *     见 category-map.ts 的 inferCategory
 *   - **没有 lifecycle / rohs / 价格库存** —— 这些字段在 ezPLM 里不存在，
 *     留着别名兜底是为了将来接别的库时不用改结构，今天一律取不到
 *
 * `attributes` 的内部结构手册没写。flattenParams 同时支持 `{k:v}` 与
 * `[{name,value}]` 两种形状 —— 拿到真实样例前这是唯一诚实的做法，
 * 两种都不匹配时参数为空，`__meta.complete=false` 会如实反映出来。
 */
export const FIELD_PATHS = {
  // 手册明确的字段
  id: ['id', 'partId', 'uuid'],
  mpn: ['mpn', 'partNumber', 'part_number', 'code', '型号'],
  manufacturer: ['manufacturer', 'brand', 'mfr', '品牌', '厂商'],
  packageCase: ['footprint', 'package', 'packageCase', 'encap', '封装'],
  datasheetUrl: ['pdf', 'datasheet', 'datasheetUrl', 'pdfUrl', '规格书'],
  params: ['attributes', 'params', 'parameters', 'specs', '参数'],
  symbol: ['symbol'],

  // ezPLM 不返回这些，留着兜底
  category: ['category', 'categoryName', 'catalogName', '类目', '分类'],
  description: ['description', 'desc', 'title', '描述'],
  lifecycle: ['lifecycle', 'status', 'lifeCycle', '生命周期'],
  rohs: ['rohs', 'isRohs'],
  price: ['price', 'priceRef', 'unitPrice'],
  stock: ['stock', 'inventory', 'qty'],
  leadTime: ['leadTime', 'leadTimeDays'],
} as const

function pick(raw: RawPart, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = raw[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

const LIFECYCLE_MAP: Record<string, PartLifecycle> = {
  active: 'ACTIVE', 在产: 'ACTIVE', 量产: 'ACTIVE',
  nrnd: 'NRND', 不推荐: 'NRND',
  eol: 'EOL', 停产: 'EOL',
  obsolete: 'OBSOLETE', 已淘汰: 'OBSOLETE',
}

/** [{name,value}] 与 {k:v} 两种参数形状都收成 {k:v} */
function flattenParams(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (Array.isArray(v)) {
    const out: Record<string, unknown> = {}
    for (const item of v) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const k = str(o.name ?? o.key ?? o.paramName ?? o['参数名'])
        const val = o.value ?? o.val ?? o['参数值']
        if (k) out[k] = val
      }
    }
    return out
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function toNormalizedPart(raw: RawPart, provider: string): NormalizedPart | null {
  const rawMpn = str(pick(raw, FIELD_PATHS.mpn))
  if (!rawMpn) return null

  // ezPLM 不返回 category，退到从 mpn + 描述推断。推不出来落 OTHER，
  // 而 OTHER 的参数白名单是空的 —— 认不出就不抽参数，不是抽错参数。
  const remoteCategory = str(pick(raw, FIELD_PATHS.category))
  const category = remoteCategory
    ? mapCategory(remoteCategory)
    : inferCategory({
        mpn: rawMpn,
        description: str(pick(raw, FIELD_PATHS.description)),
        symbol: str(pick(raw, FIELD_PATHS.symbol)),
      })
  const lifecycleRaw = str(pick(raw, FIELD_PATHS.lifecycle))?.toLowerCase().trim()

  const price = num(pick(raw, FIELD_PATHS.price))
  const stock = num(pick(raw, FIELD_PATHS.stock))
  const leadTimeDays = num(pick(raw, FIELD_PATHS.leadTime))

  return {
    mpn: normalizeMpn(rawMpn),
    rawMpn,
    manufacturer: str(pick(raw, FIELD_PATHS.manufacturer)),
    category,
    description: str(pick(raw, FIELD_PATHS.description)),
    packageCase: normalizePackage(str(pick(raw, FIELD_PATHS.packageCase))),
    datasheetUrl: str(pick(raw, FIELD_PATHS.datasheetUrl)),
    lifecycle: (lifecycleRaw && LIFECYCLE_MAP[lifecycleRaw]) || 'UNKNOWN',
    rohs: typeof raw.rohs === 'boolean' ? raw.rohs : undefined,
    params: extractParams(category, flattenParams(pick(raw, FIELD_PATHS.params)), `${provider}@v1`),
    // 价格库存单独一段，绝不混进 params —— 见 types.ts 的说明
    commercial:
      price === undefined && stock === undefined && leadTimeDays === undefined
        ? undefined
        : { priceRef: price, stock, leadTimeDays },
    source: {
      provider,
      id: str(pick(raw, FIELD_PATHS.id)),
      // 调用方会覆盖成真实抓取时间；这里给个值免得字段可空
      fetchedAt: new Date(0).toISOString(),
    },
  }
}
