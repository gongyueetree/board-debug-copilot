/**
 * S3Storage 对着一个真实 HTTP 端点跑。
 *
 * 这不是 MinIO，是一个进程内的 S3 协议假服务：只实现 path-style 的
 * PUT / GET / HEAD / DELETE，不校验签名。但请求真的经过 AWS SDK 签名、
 * 真的走 HTTP、响应头真的被 SDK 解析 —— 也就是说 head() 读 ContentLength、
 * presign 生成的 URL 能不能被 PUT、签名 URL 带不带 X-Amz-Signature，
 * 这些都是被真验证的，而不是拿 mock adapter 自证。
 *
 * 它替代不了 `pnpm test:storage-real`（那个跑真 MinIO/R2/S3，会碰到
 * 分片、权限、CORS、区域这些假服务不模拟的东西），但能保证 adapter 侧的
 * 契约不在没人跑 MinIO 的日子里悄悄退化。
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LIMITS, S3Storage } from '../src'

const BUCKET = 'bdc-test'
const objects = new Map<string, { body: Buffer; contentType: string }>()

let server: Server
let endpoint: string

/** path-style：/<bucket>/<key...>；query 里是签名参数，这里一律忽略 */
function keyOf(url: string): string | null {
  const path = decodeURIComponent(new URL(url, 'http://x').pathname)
  const prefix = `/${BUCKET}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = keyOf(req.url ?? '')
    if (!key) {
      res.writeHead(400).end()
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'] ?? 'application/octet-stream',
        })
        res.writeHead(200, { etag: '"stub"' }).end()
      })
      return
    }

    const obj = objects.get(key)

    if (req.method === 'HEAD') {
      if (!obj) {
        res.writeHead(404).end()
        return
      }
      res
        .writeHead(200, {
          'content-length': String(obj.body.byteLength),
          'content-type': obj.contentType,
        })
        .end()
      return
    }

    if (req.method === 'GET') {
      if (!obj) {
        res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error/>')
        return
      }
      res
        .writeHead(200, {
          'content-length': String(obj.body.byteLength),
          'content-type': obj.contentType,
        })
        .end(obj.body)
      return
    }

    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204).end()
      return
    }

    res.writeHead(405).end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const storage = () =>
  new S3Storage({
    endpoint,
    region: 'auto',
    bucket: BUCKET,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
  })

const KEY = 'projects/p1/kicad/demo.zip'

describe('S3Storage 对真实 HTTP 端点', () => {
  it('put 写进去的字节和 get 读出来的一致', async () => {
    const s = storage()
    const data = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256))
    const put = await s.put(KEY, data, 'application/zip')
    expect(put.sizeBytes).toBe(data.byteLength)
    expect(put.checksum).toHaveLength(16)

    const got = await s.get(KEY)
    expect(got?.equals(data)).toBe(true)
  })

  it('head 只取元信息，不拉内容', async () => {
    const s = storage()
    const data = Buffer.alloc(5000, 7)
    await s.put(KEY, data, 'application/zip')

    const head = await s.head(KEY)
    expect(head).toEqual({ sizeBytes: 5000, mimeType: 'application/zip' })
  })

  it('head 不存在的对象返回 null 而不是抛错', async () => {
    expect(await storage().head('projects/p1/kicad/missing.zip')).toBeNull()
  })

  it('get 不存在的对象返回 null', async () => {
    expect(await storage().get('projects/p1/kicad/missing.zip')).toBeNull()
  })

  it('delete 之后 head 和 get 都取不到', async () => {
    const s = storage()
    await s.put(KEY, Buffer.from('bye'), 'text/plain')
    await s.delete(KEY)
    expect(await s.head(KEY)).toBeNull()
    expect(await s.get(KEY)).toBeNull()
  })

  it('签名读 URL 指向对象且带签名参数', async () => {
    const s = storage()
    await s.put(KEY, Buffer.from('signed-read'), 'text/plain')

    const url = await s.getSignedReadUrl(KEY, 300)
    expect(url).toContain('X-Amz-Signature')
    expect(url).toContain('X-Amz-Expires=300')

    // 真去取一次：URL 拼错了这里就会 404
    const res = await fetch(url!)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('signed-read')
  })

  it('直传 URL 能被 PUT，且服务端只用 head 就能校验', async () => {
    const s = storage()
    const key = 'projects/p1/kicad/direct.zip'
    const data = Buffer.alloc(8192, 3)

    const pre = await s.createPresignedUpload({
      key,
      mimeType: 'application/zip',
      sizeBytes: data.byteLength,
    })

    expect(pre.isFallback).toBe(false)
    expect(pre.method).toBe('PUT')
    expect(pre.objectKey).toBe(key)

    const res = await fetch(pre.url, {
      method: 'PUT',
      headers: pre.headers,
      body: new Uint8Array(data),
    })
    expect(res.status).toBe(200)

    // completeUpload 走的就是这一步：不 get，只 head
    expect(await s.head(key)).toEqual({ sizeBytes: 8192, mimeType: 'application/zip' })
  })

  it('签的是确切长度而不是上限', async () => {
    // 签上限的话，任何一次真实上传的 content-length 都对不上签名。
    // 这个假服务不校验签名，所以这条只能断言 URL 里的值 ——
    // 真校验由 CI 的 MinIO job 做（SignatureDoesNotMatch 就是那么发现的）。
    const pre = await storage().createPresignedUpload({
      key: 'projects/p1/kicad/limited.zip',
      mimeType: 'application/zip',
      sizeBytes: 1234,
    })
    const url = decodeURIComponent(pre.url)
    expect(url).toContain('content-length')
    expect(url).not.toContain(String(LIMITS.zip.maxBytes))
  })
})
