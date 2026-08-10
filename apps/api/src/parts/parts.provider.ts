import { Injectable, Logger } from '@nestjs/common'
import { PartsService as CorePartsService, type MirrorStore, type NormalizedPart, type PartCategory } from '@app/parts'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Postgres 镜像的实现。
 *
 * packages/parts 只声明 MirrorStore 接口，实现留在 app 侧 —— 与
 * packages/kicad 的 PrismaLike 同一个做法，共享包不依赖 @app/db。
 */
class PrismaMirror implements MirrorStore {
  constructor(private readonly prisma: PrismaService) {}

  private toNormalized(row: {
    mpn: string
    rawMpn: string
    manufacturer: string | null
    category: string
    description: string | null
    packageCase: string | null
    datasheetUrl: string | null
    lifecycle: string
    rohs: boolean | null
    paramsJson: unknown
    commercialJson: unknown
    sourceProvider: string
    sourceId: string | null
    fetchedAt: Date
  }): NormalizedPart {
    return {
      mpn: row.mpn,
      rawMpn: row.rawMpn,
      manufacturer: row.manufacturer ?? undefined,
      category: row.category as PartCategory,
      description: row.description ?? undefined,
      packageCase: row.packageCase ?? undefined,
      datasheetUrl: row.datasheetUrl ?? undefined,
      lifecycle: row.lifecycle as NormalizedPart['lifecycle'],
      rohs: row.rohs ?? undefined,
      params: (row.paramsJson ?? {}) as NormalizedPart['params'],
      commercial: (row.commercialJson ?? undefined) as NormalizedPart['commercial'],
      source: {
        provider: row.sourceProvider,
        id: row.sourceId ?? undefined,
        fetchedAt: row.fetchedAt.toISOString(),
      },
    }
  }

  async findByMpn(mpn: string) {
    const row = await this.prisma.part.findUnique({ where: { mpn } })
    return row ? { part: this.toNormalized(row), expiresAt: row.expiresAt } : null
  }

  async findByPrefix(prefix: string, limit: number) {
    const rows = await this.prisma.part.findMany({
      where: { mpn: { startsWith: prefix } },
      take: limit,
      orderBy: { mpn: 'asc' },
    })
    return rows.map((r) => this.toNormalized(r))
  }

  async findParametric(
    category: PartCategory,
    value: number | null,
    packageCase: string | undefined,
    limit: number,
  ) {
    // 值的比较放在 JSON 里做代价高，这里先按类目+封装收窄，再在内存里筛值。
    // 阻容感的候选集本来就小，够用；真要提速就给 paramsJson 建表达式索引。
    const rows = await this.prisma.part.findMany({
      where: {
        category: category as never,
        ...(packageCase ? { packageCase } : {}),
      },
      take: limit * 5,
    })
    const parts = rows.map((r) => this.toNormalized(r))
    if (value === null) return parts.slice(0, limit)

    const keyByCategory: Partial<Record<PartCategory, string>> = {
      RESISTOR: 'resistance',
      CAPACITOR: 'capacitance',
      INDUCTOR: 'inductance',
    }
    const key = keyByCategory[category]
    if (!key) return parts.slice(0, limit)

    return parts
      .filter((p) => {
        const v = p.params[key]?.value
        // 1% 容差：BOM 里 10k 与库里 10000 应该算同一个
        return typeof v === 'number' && Math.abs(v - value) <= Math.abs(value) * 0.01
      })
      .slice(0, limit)
  }

  async upsert(part: NormalizedPart, ttlDays: number) {
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
    await this.prisma.part.upsert({
      where: { mpn: part.mpn },
      create: { mpn: part.mpn, ...data },
      update: data,
    })
  }
}

/**
 * PartsService 的 Nest 包装。
 *
 * 与 StorageService 同构：真正的逻辑在共享包里，这里只负责注入依赖
 * 与把降级状态记进日志。
 */
@Injectable()
export class PartsProviderService {
  private readonly logger = new Logger(PartsProviderService.name)
  readonly core: CorePartsService

  constructor(private readonly prisma: PrismaService) {
    this.core = new CorePartsService({ mirror: new PrismaMirror(prisma) })
    void this.core.describe().then((h) => {
      if (h.degraded) {
        this.logger.warn(`器件库降级：${h.lastError ?? '未知原因'}（provider=${h.provider}）`)
      } else {
        this.logger.log(`器件库：${h.provider}`)
      }
    })
  }

  describe() {
    return this.core.describe()
  }
}
