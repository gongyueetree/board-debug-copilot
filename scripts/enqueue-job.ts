/**
 * 手动入队一个任务，用于验证 dispatcher。
 *
 * 有 REDIS_URL 时真入队；没有时直接调 dispatch，
 * 这样没装 Redis 也能验证 processor 逻辑本身。
 *
 *   pnpm job kicad.parse '{"projectId":"...","objectKey":"...","fileId":"..."}'
 */
import { JOB_PAYLOAD_SCHEMAS, JobTypeSchema, QUEUE_NAME } from '@app/contracts'

const [, , typeArg, payloadArg] = process.argv

async function main() {
  const type = JobTypeSchema.safeParse(typeArg)
  if (!type.success) {
    console.error(`用法: pnpm job <${Object.keys(JOB_PAYLOAD_SCHEMAS).join('|')}> '<json>'`)
    process.exit(1)
  }

  let payload: unknown
  try {
    payload = JSON.parse(payloadArg ?? '{}')
  } catch {
    console.error('payload 不是合法 JSON')
    process.exit(1)
  }

  // 入队前先校验，避免把坏数据丢进队列后才在 worker 里发现
  const parsed = JOB_PAYLOAD_SCHEMAS[type.data].safeParse(payload)
  if (!parsed.success) {
    console.error('payload 校验失败:')
    for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`)
    process.exit(1)
  }

  if (!process.env.REDIS_URL) {
    console.log('REDIS_URL 未配置，直接本地执行 processor\n')
    const { dispatch } = await import('../apps/worker/src/main')
    const result = await dispatch(type.data, parsed.data)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }

  const { Queue } = await import('bullmq')
  const { default: IORedis } = await import('ioredis')
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  const queue = new Queue(QUEUE_NAME, { connection })
  const job = await queue.add(type.data, parsed.data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  })
  console.log(`已入队 ${type.data}#${job.id}`)
  await queue.close()
  await connection.quit()
}

void main()
