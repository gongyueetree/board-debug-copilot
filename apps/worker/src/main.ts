/**
 * BullMQ dispatcher。
 *
 * 单队列 bdc-jobs，按 job.name 分派到 processor。用单队列而不是每类一个队列：
 * 任务量级差着数量级（解析几十秒、BOM 匹配几百毫秒），拆队列只会让
 * 大部分队列常年空转，而 BullMQ 的并发控制本来就是按 worker 而非按队列的。
 *
 * 无 REDIS_URL 时空转而不退出 —— 本地开发不该被迫起 Redis
 * （CLAUDE.md 硬性原则 #1：每个 Phase 结束 pnpm dev 必须能启动）。
 */
import { JOB_PAYLOAD_SCHEMAS, JobTypeSchema, QUEUE_NAME, type JobResult } from '@app/contracts'
import { disconnect, prisma, type JobContext } from './context'
import { aiLongTaskProcessor } from './processors/ai-long-task.processor'
import { kicadParseProcessor } from './processors/kicad-parse.processor'
import { partsMatchProcessor } from './processors/parts-match.processor'
import { reportGenerateProcessor } from './processors/report-generate.processor'

type Processor = (payload: unknown, ctx: JobContext) => Promise<JobResult>

const PROCESSORS: Record<string, Processor> = {
  'kicad.parse': kicadParseProcessor,
  'report.generate': reportGenerateProcessor,
  'ai.long-task': aiLongTaskProcessor,
  'parts.match-bom': partsMatchProcessor,
}

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2)

function log(msg: string) {
  console.log(`[worker] ${new Date().toISOString()} ${msg}`)
}

async function dispatch(name: string, payload: unknown): Promise<JobResult> {
  const started = Date.now()

  const type = JobTypeSchema.safeParse(name)
  if (!type.success) {
    return {
      ok: false,
      summary: `未知任务类型 ${name}`,
      error: `支持的类型：${Object.keys(PROCESSORS).join(', ')}`,
      data: {},
      durationMs: Date.now() - started,
    }
  }

  // 入队侧已校验过一次，这里再校验是因为队列是进程边界：
  // 旧版本 API 入队的 payload 可能与当前 schema 不符
  const schema = JOB_PAYLOAD_SCHEMAS[type.data]
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      summary: `${name} payload 不符合当前 schema`,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      data: {},
      durationMs: Date.now() - started,
    }
  }

  return PROCESSORS[type.data]!(parsed.data, { prisma: prisma(), log })
}

/** 供测试脚本直接调用，不经 Redis */
export { dispatch }

async function main() {
  const redisUrl = process.env.REDIS_URL

  if (!redisUrl) {
    log('REDIS_URL 未配置，进入降级空转模式')
    log(`可处理的任务类型：${Object.keys(PROCESSORS).join(', ')}`)
    log('配置 REDIS_URL 后重启即可开始消费队列')
    setInterval(() => {}, 1 << 30)
    return
  }

  const { Worker, Queue } = await import('bullmq')
  const { default: IORedis } = await import('ioredis')

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })
  connection.on('error', (err) => log(`Redis 连接错误: ${err.message}`))

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      log(`收到 ${job.name}#${job.id}`)
      const result = await dispatch(job.name, job.data)
      log(
        `${result.ok ? '完成' : '失败'} ${job.name}#${job.id} ` +
          `(${result.durationMs}ms) ${result.summary}` +
          (result.error ? ` — ${result.error.slice(0, 200)}` : ''),
      )
      // processor 已把失败写回数据库；这里抛出是为了让 BullMQ 记为 failed 并重试
      if (!result.ok) throw new Error(result.error ?? result.summary)
      return result
    },
    { connection, concurrency: CONCURRENCY },
  )

  worker.on('failed', (job, err) => log(`任务失败 ${job?.name}#${job?.id}: ${err.message}`))
  worker.on('error', (err) => log(`worker 错误: ${err.message}`))

  // 健康心跳：让运维能从日志判断 worker 是活的还是卡住了
  const queue = new Queue(QUEUE_NAME, { connection })
  const heartbeat = setInterval(async () => {
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'failed', 'delayed')
      log(
        `健康 | 等待 ${counts.waiting} 活动 ${counts.active} 失败 ${counts.failed} 延迟 ${counts.delayed}`,
      )
    } catch (err) {
      log(`健康检查失败: ${(err as Error).message}`)
    }
  }, 60_000)

  log(`已连接 Redis，监听 ${QUEUE_NAME}，并发 ${CONCURRENCY}`)
  log(`可处理：${Object.keys(PROCESSORS).join(', ')}`)

  const shutdown = async (sig: string) => {
    log(`收到 ${sig}，正在停止…`)
    clearInterval(heartbeat)
    await worker.close()
    await queue.close()
    await connection.quit()
    await disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// 只在直接运行时启动。被 enqueue 脚本 import 时不该拉起空转循环。
// worker 编译成 CommonJS，所以用 require.main 而不是 import.meta。
declare const require: NodeJS.Require | undefined
declare const module: NodeJS.Module | undefined

const isEntrypoint =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module

if (isEntrypoint || process.env.WORKER_AUTOSTART === 'true') {
  void main()
}
