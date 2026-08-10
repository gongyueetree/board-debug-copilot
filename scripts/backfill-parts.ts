/**
 * 存量 Component 的器件库回填。
 *
 *   pnpm tsx scripts/backfill-parts.ts --dry-run
 *   pnpm tsx scripts/backfill-parts.ts --project <id>
 *   PARTS_PROVIDER=remote pnpm tsx scripts/backfill-parts.ts
 *
 * **输出的分层匹配率就是 P9 的验收依据**（L1+L2 ≥ 70%）。所以统计要比写库更重要：
 * --dry-run 什么都不写，但该算的一样算完。
 */
import { PrismaClient } from '@prisma/client'
import {
  PartsService,
  isAutoAccepted,
  paramCompleteness,
  type MatchResult,
  type MirrorStore,
  type NormalizedPart,
  type PartCategory,
} from '@app/parts'

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const PROJECT = argv[argv.indexOf('--project') + 1]
const onlyProject = argv.includes('--project') ? PROJECT : undefined

const prisma = new PrismaClient()

/** 与 apps/api 的 PrismaMirror 同一套读写，脚本侧单独实现一份精简版 */
const mirror: MirrorStore = {
  async findByMpn(mpn) {
    const row = await prisma.part.findUnique({ where: { mpn } })
    return row ? { part: rowToPart(row), expiresAt: row.expiresAt } : null
  },
  async findByPrefix(prefix, limit) {
    const rows = await prisma.part.findMany({
      where: { mpn: { startsWith: prefix } },
      take: limit,
    })
    return rows.map(rowToPart)
  },
  async findParametric(category, _value, packageCase, limit) {
    const rows = await prisma.part.findMany({
      where: { category: category as never, ...(packageCase ? { packageCase } : {}) },
      take: limit,
    })
    return rows.map(rowToPart)
  },
  async upsert(part, ttlDays) {
    if (DRY_RUN) return
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000)
    const data = {
      rawMpn: part.rawMpn,
      manufacturer: part.manufacturer ?? null,
      category: part.category as never,
      description: part.description ?? null,
      packageCase: part.packageCase ?? null,
      datasheetUrl: part.datasheetUrl ?? null,
      lifecycle: part.lifecycle as never,
      rohs: part.rohs ?? null,
      paramsJson: part.params as never,
      commercialJson: (part.commercial ?? null) as never,
      sourceProvider: part.source.provider,
      sourceId: part.source.id ?? null,
      fetchedAt: new Date(part.source.fetchedAt),
      expiresAt,
    }
    await prisma.part.upsert({
      where: { mpn: part.mpn },
      create: { mpn: part.mpn, ...data },
      update: data,
    })
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPart(row: any): NormalizedPart {
  return {
    mpn: row.mpn,
    rawMpn: row.rawMpn,
    manufacturer: row.manufacturer ?? undefined,
    category: row.category as PartCategory,
    description: row.description ?? undefined,
    packageCase: row.packageCase ?? undefined,
    datasheetUrl: row.datasheetUrl ?? undefined,
    lifecycle: row.lifecycle,
    rohs: row.rohs ?? undefined,
    params: row.paramsJson ?? {},
    commercial: row.commercialJson ?? undefined,
    source: {
      provider: row.sourceProvider,
      id: row.sourceId ?? undefined,
      fetchedAt: row.fetchedAt.toISOString(),
    },
  }
}

const pct = (n: number, total: number) => (total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`)

async function main() {
  const parts = new PartsService({ mirror })
  const health = await parts.describe()

  console.log('器件库回填')
  console.log(`  provider   ${health.provider}${health.degraded ? '（已降级）' : ''}`)
  if (health.lastError) console.log(`  降级原因   ${health.lastError}`)
  console.log(`  模式       ${DRY_RUN ? 'dry-run（不写库）' : '写库'}`)
  if (onlyProject) console.log(`  限定项目   ${onlyProject}`)
  console.log()

  const components = await prisma.component.findMany({
    where: onlyProject ? { projectId: onlyProject } : {},
    select: {
      id: true,
      ref: true,
      value: true,
      partNumber: true,
      manufacturer: true,
      footprint: true,
      projectId: true,
    },
    orderBy: [{ projectId: 'asc' }, { ref: 'asc' }],
  })

  if (components.length === 0) {
    console.log('没有可回填的组件')
    return
  }

  const byMethod: Record<string, number> = { EXACT: 0, PREFIX: 0, PARAMETRIC: 0, VECTOR: 0 }
  const results: MatchResult[] = []
  let unmatched = 0
  let needsReview = 0
  const paramStats = new Map<string, { got: number; want: number; n: number }>()

  for (const c of components) {
    const r = await parts.matchComponent(c)
    results.push(r)

    if (r.status === 'UNMATCHED' || !r.part) {
      unmatched++
    } else {
      byMethod[r.method] = (byMethod[r.method] ?? 0) + 1
      if (!isAutoAccepted(r.confidence)) needsReview++

      const { got, want } = paramCompleteness(r.part.category, r.part.params)
      const acc = paramStats.get(r.part.category) ?? { got: 0, want: 0, n: 0 }
      paramStats.set(r.part.category, { got: acc.got + got, want: acc.want + want, n: acc.n + 1 })

      if (!DRY_RUN) {
        await mirror.upsert(r.part, 7)
        const part = await prisma.part.findUnique({ where: { mpn: r.part.mpn } })
        if (part) {
          await prisma.component.update({
            where: { id: c.id },
            data: { partId: part.id, matchStatus: r.status as never },
          })
          await prisma.partMatch.create({
            data: {
              componentId: c.id,
              source: health.provider === 'remote' ? 'REAL_DB' : 'MOCK',
              matchedPartNumber: r.part.mpn,
              confidence: r.confidence,
              method: r.method as never,
              // 低置信一律等人确认 —— 自动采纳是这类系统最典型的翻车方式
              accepted: isAutoAccepted(r.confidence),
              summaryJson: { reason: r.reason } as never,
            },
          })
        }
      }
    }
  }

  const total = components.length
  const l1l2 = (byMethod.EXACT ?? 0) + (byMethod.PREFIX ?? 0)

  console.log(`共 ${total} 个组件\n`)
  console.log('  层    方法          命中    占比')
  console.log(`  L1    MPN 精确      ${String(byMethod.EXACT ?? 0).padStart(4)}    ${pct(byMethod.EXACT ?? 0, total)}`)
  console.log(`  L2    型号前缀      ${String(byMethod.PREFIX ?? 0).padStart(4)}    ${pct(byMethod.PREFIX ?? 0, total)}`)
  console.log(`  L3    参数化        ${String(byMethod.PARAMETRIC ?? 0).padStart(4)}    ${pct(byMethod.PARAMETRIC ?? 0, total)}`)
  console.log(`  L4    向量语义      ${String(byMethod.VECTOR ?? 0).padStart(4)}    ${pct(byMethod.VECTOR ?? 0, total)}`)
  console.log(`  —     未匹配        ${String(unmatched).padStart(4)}    ${pct(unmatched, total)}`)
  console.log()
  console.log(`  L1+L2 匹配率 ${pct(l1l2, total)}（P9 验收线 ≥ 70%）`)
  console.log(`  待人工确认   ${needsReview} 条（confidence < 0.6）`)

  if (paramStats.size > 0) {
    console.log('\n  参数完整率（决定 P10 的实际收益）')
    for (const [cat, s] of [...paramStats].sort()) {
      console.log(`    ${cat.padEnd(12)} ${pct(s.got, s.want).padStart(6)}   ${s.n} 个器件`)
    }
  }

  const lowConf = results.filter((r) => r.part && !isAutoAccepted(r.confidence))
  if (lowConf.length > 0) {
    console.log('\n  待确认明细（人工抽检从这里开始）')
    for (const r of lowConf.slice(0, 20)) {
      console.log(`    ${r.componentRef.padEnd(6)} ${r.confidence.toFixed(2)}  ${r.reason}`)
    }
  }

  if (DRY_RUN) console.log('\n（dry-run：以上统计已算完，但没有写库）')
}

main()
  .catch((err) => {
    console.error('回填失败：', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
