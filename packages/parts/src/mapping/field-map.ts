import type { NormalizedPart, PartLifecycle, RawPart } from '../types'
import { mapCategory } from './category-map'
import { normalizePackage } from './unit'
import { normalizeMpn } from '../normalize/mpn'
import { extractParams } from '../normalize/params'

/**
 * ★ 参考文件的主要落地处：远端字段 → NormalizedPart。
 *
 * 现在这里是**按最常见的字段名猜的**，因为参考文件（§2.2 的九项）还没提供。
 * 拿到之后把 FIELD_PATHS 换成真实字段名即可，其余代码一行都不用动 ——
 * 这正是把映射收敛到一个文件的意义。
 *
 * 在换成真实映射之前，remote provider 由 factory 拦住不让启用（见
 * providers/remote.ts 的 MISSING_SPEC），所以这里的猜测不会静默产出错误参数。
 */
export const FIELD_PATHS = {
  mpn: ['mpn', 'partNumber', 'part_number', 'code', '型号'],
  manufacturer: ['manufacturer', 'brand', 'mfr', '品牌', '厂商'],
  category: ['category', 'categoryName', 'catalogName', '类目', '分类'],
  description: ['description', 'desc', 'title', '描述'],
  packageCase: ['package', 'packageCase', 'encap', '封装'],
  datasheetUrl: ['datasheet', 'datasheetUrl', 'pdfUrl', '规格书'],
  lifecycle: ['lifecycle', 'status', 'lifeCycle', '生命周期'],
  rohs: ['rohs', 'isRohs'],
  /** 参数通常是个嵌套对象或 [{name,value}] 数组 */
  params: ['params', 'parameters', 'attributes', 'specs', '参数'],
  price: ['price', 'priceRef', 'unitPrice'],
  stock: ['stock', 'inventory', 'qty'],
  leadTime: ['leadTime', 'leadTimeDays'],
  id: ['id', 'partId', 'uuid'],
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

  const category = mapCategory(str(pick(raw, FIELD_PATHS.category)))
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
