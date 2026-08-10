import type { NormalizedPart, PartCategory } from '../types'

/**
 * Postgres 镜像的读写契约。
 *
 * 只声明用到的方法，不依赖 @app/db 的完整类型 —— 与 packages/kicad 的
 * PrismaLike 同一个做法。实现由 apps/api / apps/worker 注入。
 */
export interface MirrorStore {
  findByMpn(mpn: string): Promise<{ part: NormalizedPart; expiresAt: Date | null } | null>
  findByPrefix(prefix: string, limit: number): Promise<NormalizedPart[]>
  findParametric(
    category: PartCategory,
    value: number | null,
    packageCase: string | undefined,
    limit: number,
  ): Promise<NormalizedPart[]>
  upsert(part: NormalizedPart, ttlDays: number): Promise<void>
}

export interface MirrorStats {
  hits: number
  misses: number
  staleServed: number
}

/**
 * 三级读取的中间层。
 *
 * **过期后先返回旧值再异步刷新**，不阻塞调用方 —— 器件参数一周不变是常态，
 * 为了拿最新的 1% 差异让 BOM 页多等两秒不划算。刷新失败也不影响本次返回，
 * 只是下次还会再试。
 */
export class Mirror {
  readonly stats: MirrorStats = { hits: 0, misses: 0, staleServed: 0 }
  private readonly refreshing = new Set<string>()

  constructor(
    private readonly store: MirrorStore,
    private readonly ttlDays: number,
  ) {}

  async get(
    mpn: string,
    refresh: (mpn: string) => Promise<NormalizedPart | null>,
  ): Promise<NormalizedPart | null> {
    const row = await this.store.findByMpn(mpn)
    if (!row) {
      this.stats.misses++
      return null
    }

    this.stats.hits++
    const stale = row.expiresAt !== null && row.expiresAt.getTime() < Date.now()
    if (stale && !this.refreshing.has(mpn)) {
      this.stats.staleServed++
      this.refreshing.add(mpn)
      // 有意不 await：先把旧值还回去
      void refresh(mpn)
        .then((fresh) => (fresh ? this.store.upsert(fresh, this.ttlDays) : undefined))
        .catch(() => {
          // 刷新失败不影响本次返回，下次还会再试。
          // 不静默丢弃错误信息：调用方通过 hitRate 与 /health 能看出镜像在变陈旧。
        })
        .finally(() => this.refreshing.delete(mpn))
    }
    return row.part
  }

  put(part: NormalizedPart): Promise<void> {
    return this.store.upsert(part, this.ttlDays)
  }

  byPrefix(prefix: string, limit = 10): Promise<NormalizedPart[]> {
    return this.store.findByPrefix(prefix, limit)
  }

  byParametric(
    category: PartCategory,
    value: number | null,
    packageCase: string | undefined,
    limit = 10,
  ): Promise<NormalizedPart[]> {
    return this.store.findParametric(category, value, packageCase, limit)
  }

  /** 镜像命中率，无请求时为 null（0 会被误读成「全都没命中」） */
  get hitRate(): number | null {
    const total = this.stats.hits + this.stats.misses
    return total === 0 ? null : this.stats.hits / total
  }
}
