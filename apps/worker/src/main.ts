/**
 * BullMQ worker — KiCad 解析 / ERC-DRC / BOM 匹配 / 报告生成
 *
 * 无 Redis 时降级为空转，不阻塞 `pnpm dev`（P0 验收要求）。
 * 队列与处理器随 P1（解析）与 P7（报告）落地。
 */
const QUEUE_NAME = 'bdc-jobs'

async function main() {
  const redisUrl = process.env.REDIS_URL

  if (!redisUrl) {
    console.log('[worker] REDIS_URL 未配置，进入降级空转模式（P0 允许）')
    console.log('[worker] 配置 REDIS_URL 后将监听队列:', QUEUE_NAME)
    setInterval(() => {}, 1 << 30)
    return
  }

  const { Worker } = await import('bullmq')
  const { default: IORedis } = await import('ioredis')

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[worker] 收到任务 ${job.name}#${job.id}，处理器随 P1/P7 落地`)
      return { ok: true }
    },
    { connection },
  )

  worker.on('failed', (job, err) => {
    console.error(`[worker] 任务失败 ${job?.name}#${job?.id}:`, err.message)
  })

  console.log(`[worker] 已连接 Redis，监听队列 ${QUEUE_NAME}`)
}

void main()
