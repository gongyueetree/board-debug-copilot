/**
 * 真实 S3 兼容存储端到端验证。
 *
 *   docker compose -f docker-compose.storage.yml up -d
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=bdc-test \
 *   S3_ACCESS_KEY_ID=bdc-test-key S3_SECRET_ACCESS_KEY=bdc-test-secret \
 *     pnpm test:storage-real
 *
 * 没配 S3_* 就 SKIPPED 并退 0。CI 默认不跑这条 —— 它需要一个真实端点，
 * 而 CI 不该依赖外部资源，也不该为了跑测试去开一个公网桶。
 *
 * 这里验的是 adapter 与真实对象存储之间的契约（签名、head、直传），
 * 不是业务逻辑。业务侧「只 head 不 get」的规则在
 * apps/api/test/kicad-complete.test.ts 里用替身盯着，两边互补。
 */
import { LIMITS, S3Storage, S3ConfigSchema, validateUpload, type StorageAdapter } from '@app/storage'
import { randomUUID } from 'node:crypto'

const PREFIX = `projects/storage-real-${randomUUID()}`

interface Check {
  name: string
  run: (s: StorageAdapter) => Promise<string>
}

const expect = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg)
}

const checks: Check[] = [
  {
    name: 'put + head：元信息与内容一致',
    run: async (s) => {
      const key = `${PREFIX}/put.txt`
      const data = Buffer.from('board-debug-copilot storage check', 'utf8')
      const put = await s.put(key, data, 'text/plain')
      expect(put.sizeBytes === data.byteLength, `put 报的大小 ${put.sizeBytes} 不对`)

      const head = await s.head(key)
      expect(head !== null, 'head 返回 null，对象没写进去')
      expect(head!.sizeBytes === data.byteLength, `head 大小 ${head!.sizeBytes} 与实际不符`)
      // R2 与 MinIO 都会回 ContentType；AWS S3 也会。回不出来说明 put 没带上
      expect(head!.mimeType === 'text/plain', `head mimeType=${head!.mimeType}`)
      return `${head!.sizeBytes} 字节 / ${head!.mimeType}`
    },
  },
  {
    name: 'head 不存在的 key 返回 null 而不是抛错',
    run: async (s) => {
      const head = await s.head(`${PREFIX}/nope-${randomUUID()}.bin`)
      expect(head === null, 'head 对不存在的对象应返回 null')
      return 'null'
    },
  },
  {
    name: 'get：内容逐字节一致',
    run: async (s) => {
      const key = `${PREFIX}/get.bin`
      // 用二进制而不是文本：编码问题在纯 ASCII 上看不出来
      const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
      await s.put(key, data, 'application/octet-stream')
      const got = await s.get(key)
      expect(got !== null, 'get 返回 null')
      expect(got!.equals(data), 'get 回来的内容和写进去的不一致')
      return `${got!.byteLength} 字节一致`
    },
  },
  {
    name: 'getSignedReadUrl：签名 URL 能真正取到对象',
    run: async (s) => {
      const key = `${PREFIX}/signed.txt`
      const data = Buffer.from('signed-read', 'utf8')
      await s.put(key, data, 'text/plain')

      const url = await s.getSignedReadUrl(key, 300)
      expect(!!url, 'getSignedReadUrl 返回 null')
      expect(url!.includes('X-Amz-Signature'), '返回的不是签名 URL')

      const res = await fetch(url!)
      expect(res.ok, `签名 URL 取对象失败 HTTP ${res.status}`)
      expect((await res.text()) === 'signed-read', '签名 URL 取回的内容不对')
      return `HTTP 200，有效期 300s`
    },
  },
  {
    name: 'createPresignedUpload：浏览器直传后服务端只 head',
    run: async (s) => {
      const key = `${PREFIX}/direct.zip`
      const data = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7) % 256))

      const pre = await s.createPresignedUpload({
        key,
        mimeType: 'application/zip',
        // 确切长度：签的是这个数，传多传少都会被对象存储拒掉
        sizeBytes: data.byteLength,
      })
      expect(pre.isFallback === false, 's3 模式不该返回 fallback')
      expect(pre.method === 'PUT', `直传方法应为 PUT，实得 ${pre.method}`)

      // 模拟浏览器：直接 PUT 到对象存储，完全不经过 API 进程
      const put = await fetch(pre.url, {
        method: 'PUT',
        headers: pre.headers,
        body: new Uint8Array(data),
      })
      expect(put.ok, `直传失败 HTTP ${put.status}：${(await put.text()).slice(0, 200)}`)

      // completeUpload 的核心：只取元信息，不把 100MB 拉进进程
      const head = await s.head(key)
      expect(head !== null, '直传后 head 取不到对象')
      expect(head!.sizeBytes === data.byteLength, `head 大小 ${head!.sizeBytes} 与直传内容不符`)

      // 声明多少就必须传多少：多传一个字节，签名就该对不上
      const tamper = await fetch(pre.url, {
        method: 'PUT',
        headers: pre.headers,
        body: new Uint8Array(Buffer.concat([data, Buffer.from([0])])),
      })
      expect(!tamper.ok, `多传一字节竟然成功了 HTTP ${tamper.status} —— 长度没被签进签名`)

      return `直传 ${data.byteLength} 字节通过，超一字节被拒（HTTP ${tamper.status}）`
    },
  },
  {
    name: '超限对象：complete 应拒绝并删除',
    run: async (s) => {
      const key = `${PREFIX}/oversize.zip`
      // 不真传 100MB：把限制临时当成小值来走同一条判定分支，
      // 验的是「拒绝 + 删除」这套动作，不是对象存储能不能存下大文件
      const data = Buffer.alloc(2048, 1)
      await s.put(key, data, 'application/zip')

      const head = await s.head(key)
      expect(head !== null, '对象没写进去')

      let rejected = false
      try {
        // 与 KicadService.completeUpload 同一套校验函数
        validateUpload('zip', head!.mimeType ?? 'application/zip', LIMITS.zip.maxBytes + 1)
      } catch {
        rejected = true
        await s.delete(key)
      }
      expect(rejected, '超限没有被拒绝')
      expect((await s.head(key)) === null, '被拒的对象没有从存储里删掉')
      return '已拒绝并删除'
    },
  },
  {
    name: 'delete：删除后 head 与 get 都取不到',
    run: async (s) => {
      const key = `${PREFIX}/delete-me.txt`
      await s.put(key, Buffer.from('bye'), 'text/plain')
      await s.delete(key)
      expect((await s.head(key)) === null, '删除后 head 仍有结果')
      expect((await s.get(key)) === null, '删除后 get 仍有内容')
      return 'head/get 均为 null'
    },
  },
]

async function cleanup(s: StorageAdapter) {
  const keys = [
    'put.txt',
    'get.bin',
    'signed.txt',
    'direct.zip',
    'oversize.zip',
    'delete-me.txt',
  ].map((n) => `${PREFIX}/${n}`)
  await Promise.all(keys.map((k) => s.delete(k).catch(() => {})))
}

async function main() {
  console.log('真实 S3 兼容存储验证')

  const parsed = S3ConfigSchema.safeParse({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  })

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    console.log(`  SKIPPED  缺少 S3 配置：${missing}`)
    console.log('           本地起 MinIO：docker compose -f docker-compose.storage.yml up -d')
    console.log('           完整步骤见 docs/09-storage-validation.md')
    process.exit(0)
  }

  const storage = new S3Storage(parsed.data)
  console.log(
    `  endpoint  ${parsed.data.endpoint ?? '(AWS 默认)'}\n` +
      `  bucket    ${parsed.data.bucket}\n` +
      `  prefix    ${PREFIX}\n`,
  )

  let failed = 0
  for (const c of checks) {
    try {
      console.log(`  ✓ ${c.name.padEnd(40)} ${await c.run(storage)}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${c.name.padEnd(40)} ${(err as Error).message}`)
    }
  }

  // 失败也要清理：留一堆测试对象在桶里会让下次结果更难读
  await cleanup(storage)

  console.log(`\n${checks.length - failed}/${checks.length} 通过`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
