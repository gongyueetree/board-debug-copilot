import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import {
  JOB_PAYLOAD_SCHEMAS,
  QUEUE_NAME,
  type EnqueueResult,
  type JobType,
} from '@app/contracts'

/**
 * 入队门面。
 *
 * 没有 REDIS_URL 时不报错 —— 返回 degraded=true，调用方决定是同步执行
 * 还是跳过。本地开发不该被迫起 Redis（CLAUDE.md 硬性原则 #1）。
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private connection: any = null
  private initPromise: Promise<void> | null = null

  get available(): boolean {
    return Boolean(process.env.REDIS_URL)
  }

  private async init(): Promise<void> {
    if (this.queue || !this.available) return
    this.initPromise ??= (async () => {
      const { Queue } = await import('bullmq')
      const { default: IORedis } = await import('ioredis')
      this.connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null })
      this.connection.on('error', (err: Error) =>
        this.logger.warn(`Redis 连接错误: ${err.message}`),
      )
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection })
      this.logger.log(`已连接队列 ${QUEUE_NAME}`)
    })()
    await this.initPromise
  }

  async enqueue(type: JobType, payload: unknown): Promise<EnqueueResult> {
    // 入队前校验：坏数据不该进队列，否则要等 worker 出队才发现
    const parsed = JOB_PAYLOAD_SCHEMAS[type].safeParse(payload)
    if (!parsed.success) {
      return {
        enqueued: false,
        jobId: null,
        degraded: false,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      }
    }

    if (!this.available) {
      return { enqueued: false, jobId: null, degraded: true, reason: 'REDIS_URL 未配置' }
    }

    try {
      await this.init()
      const job = await this.queue.add(type, parsed.data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      })
      this.logger.log(`已入队 ${type}#${job.id}`)
      return { enqueued: true, jobId: String(job.id), degraded: false, reason: null }
    } catch (err) {
      this.logger.warn(`入队失败 ${type}: ${(err as Error).message}`)
      return {
        enqueued: false,
        jobId: null,
        degraded: true,
        reason: (err as Error).message.slice(0, 200),
      }
    }
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => {})
    await this.connection?.quit().catch(() => {})
  }
}
