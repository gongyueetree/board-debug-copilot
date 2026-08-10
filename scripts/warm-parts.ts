/**
 * 器件库预热。
 *
 *   pnpm parts:warm --category opamp,ldo,dac --top 500
 *
 * 为什么需要它：`PartKnowledge` 空着的话，`searchPartsDatabase` 工具永远返回
 * 零条，向量检索形同虚设 —— 接了 110 万条也跟没接一样。预热是给检索准备底料。
 *
 * mock provider 下只有内置那几颗，预热本身没意义但流程是通的；
 * 真正的价值在 PARTS_PROVIDER=remote 时。
 */
import { PrismaClient } from '@prisma/client'
import { PartsService, PART_CATEGORIES, type PartCategory } from '@app/parts'

const argv = process.argv.slice(2)
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const categories = (arg('category') ?? 'opamp,ldo,dac')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter((c): c is PartCategory => (PART_CATEGORIES as readonly string[]).includes(c))
const top = Number(arg('top') ?? 100)

const prisma = new PrismaClient()

async function main() {
  const parts = new PartsService()
  const health = await parts.describe()

  console.log('器件库预热')
  console.log(`  provider ${health.provider}${health.degraded ? '（已降级）' : ''}`)
  if (health.lastError) console.log(`  原因     ${health.lastError}`)
  console.log(`  类目     ${categories.join(', ') || '(无有效类目)'}`)
  console.log(`  每类上限 ${top}\n`)

  if (categories.length === 0) {
    console.log(`没有有效类目。可选：${PART_CATEGORIES.join(', ')}`)
    return
  }

  let warmed = 0
  for (const cat of categories) {
    const hits = await parts.searchByKeyword(cat, { limit: top })
    for (const p of hits) {
      await prisma.part.upsert({
        where: { mpn: p.mpn },
        create: {
          mpn: p.mpn,
          rawMpn: p.rawMpn,
          manufacturer: p.manufacturer ?? null,
          category: p.category as never,
          description: p.description ?? null,
          packageCase: p.packageCase ?? null,
          datasheetUrl: p.datasheetUrl ?? null,
          lifecycle: p.lifecycle as never,
          paramsJson: p.params as never,
          sourceProvider: p.source.provider,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
        update: { paramsJson: p.params as never, fetchedAt: new Date() },
      })
      warmed++
    }
    console.log(`  ${cat.padEnd(12)} ${hits.length} 条`)
  }

  console.log(`\n共写入/更新 ${warmed} 条镜像`)
  if (health.provider === 'mock') {
    console.log('（mock provider 只有内置几颗；真正的预热要 PARTS_PROVIDER=remote）')
  }
}

main()
  .catch((err) => {
    console.error('预热失败：', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
