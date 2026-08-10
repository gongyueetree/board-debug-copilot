/**
 * 进程内 LRU。
 *
 * 挡的是「同一次解析里的重复查询」：一块板上 24 颗 10k 电阻会查 24 次
 * 同一个 MPN。TTL 短（60s）是有意的 —— 它不是持久缓存，那是镜像的活。
 */
export class LruCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>()

  constructor(
    private readonly capacity = 2000,
    private readonly ttlMs = 60_000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (hit.expiresAt < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    // 重新插入以更新 LRU 顺序（Map 保持插入序）
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
