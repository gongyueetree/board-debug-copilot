/**
 * 直传完成回调的行为契约。
 *
 * 两条规则值得单独钉住：
 *   1. 只 head，不 get —— 100MB 的 zip 不该为了校验大小被整个拉进 API 进程。
 *      改回 get() 功能上照样能跑，只有压测时才会暴露，所以在这里挡。
 *   2. 校验不通过的对象要删掉 —— 它已经在桶里了，且不会有任何流程再用到它。
 *
 * 不起 Nest 容器：KicadService 的依赖是三个普通对象，直接注入替身即可。
 */
import { describe, expect, it } from 'vitest'
import { KicadService } from '../src/kicad/kicad.service'
import { LIMITS } from '@app/storage'

const PROJECT = '00000000-0000-0000-0000-0000000000d1'
const KEY = `projects/${PROJECT}/kicad/demo.zip`

function harness(head: { sizeBytes: number; mimeType: string | null } | null) {
  const calls = {
    get: 0,
    head: 0,
    deleted: [] as string[],
    created: [] as Record<string, unknown>[],
  }

  const storage = {
    describe: () => ({ adapter: 'mock' }),
    validate(kind: 'zip', mimeType: string, sizeBytes: number) {
      const limit = LIMITS[kind]
      if (!limit.mimes.includes(mimeType)) throw new Error(`BAD_MIME ${mimeType}`)
      if (sizeBytes > limit.maxBytes) throw new Error(`TOO_LARGE ${sizeBytes}`)
    },
    async head(key: string) {
      calls.head++
      return head && key === KEY ? head : null
    },
    async get() {
      calls.get++
      return Buffer.alloc(0)
    },
    async delete(key: string) {
      calls.deleted.push(key)
    },
  }

  const prisma = {
    project: {
      findUnique: async () => ({ id: PROJECT, designVersion: 1 }),
      update: async () => ({ id: PROJECT }),
    },
    projectFile: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.created.push(data)
        return { id: 'file-1', ...data }
      },
    },
  }

  const queue = { enqueue: async () => ({ enqueued: true, jobId: 'job-1' }) }

  // 三个依赖都是结构化替身，用 as never 绕过 Nest 的具体类型
  const service = new KicadService(prisma as never, storage as never, queue as never)
  return { service, calls }
}

describe('completeUpload', () => {
  it('只取元信息，不把对象内容拉进进程', async () => {
    const { service, calls } = harness({ sizeBytes: 2048, mimeType: 'application/zip' })

    const r = await service.completeUpload(PROJECT, {
      objectKey: KEY,
      filename: 'demo.zip',
      sizeBytes: 2048,
    })

    expect(r.status).toBe('QUEUED')
    expect(calls.head).toBe(1)
    expect(calls.get).toBe(0)
  })

  it('大小以存储为准，不信任前端上报的数字', async () => {
    const { service, calls } = harness({ sizeBytes: 127, mimeType: 'application/zip' })
    await service.completeUpload(PROJECT, {
      objectKey: KEY,
      filename: 'demo.zip',
      // 前端谎报 999999，实际对象只有 127 字节
      sizeBytes: 999999,
    })
    expect(calls.created[0]?.sizeBytes).toBe(127)
  })

  it('对象不存在时报 404 而不是登记一条指向空气的记录', async () => {
    const { service, calls } = harness(null)
    await expect(
      service.completeUpload(PROJECT, { objectKey: KEY, filename: 'demo.zip', sizeBytes: 1 }),
    ).rejects.toThrow(/对象不存在/)
    expect(calls.created).toHaveLength(0)
  })

  it('超限对象被拒绝，并从存储里删掉', async () => {
    const { service, calls } = harness({
      sizeBytes: LIMITS.zip.maxBytes + 1,
      mimeType: 'application/zip',
    })
    await expect(
      service.completeUpload(PROJECT, { objectKey: KEY, filename: 'big.zip', sizeBytes: 10 }),
    ).rejects.toThrow()
    expect(calls.deleted).toEqual([KEY])
    expect(calls.created).toHaveLength(0)
  })

  it('MIME 不对同样拒绝并清理', async () => {
    const { service, calls } = harness({ sizeBytes: 100, mimeType: 'text/html' })
    await expect(
      service.completeUpload(PROJECT, { objectKey: KEY, filename: 'x.zip', sizeBytes: 100 }),
    ).rejects.toThrow()
    expect(calls.deleted).toEqual([KEY])
  })
})
