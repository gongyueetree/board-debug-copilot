/**
 * @app/storage — 对象存储 adapter
 *
 * apps/api 与 apps/worker 都要读写同一批对象（zip、产物、照片、波形）。
 * 放在共享包里而不是各自实现：S3 客户端配置、key 规范化、大小限制
 * 一旦分成两份，迟早漂移。
 *
 * STORAGE_ADAPTER=mock 落本地盘（无盘环境退回内存），=s3 走 S3 兼容端点，
 * Cloudflare R2 / AWS S3 / MinIO 都适用。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const FILE_KINDS = ['zip', 'photo', 'waveform', 'report', 'artifact'] as const
export type FileKindKey = (typeof FILE_KINDS)[number]

/** 上传限制（CLAUDE.md 硬性原则 #7） */
export const LIMITS: Record<FileKindKey, { maxBytes: number; mimes: readonly string[] }> = {
  zip: {
    maxBytes: 100 * 1024 * 1024,
    mimes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  },
  photo: { maxBytes: 20 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
  waveform: { maxBytes: 50 * 1024 * 1024, mimes: ['application/json', 'application/octet-stream'] },
  report: {
    maxBytes: 20 * 1024 * 1024,
    mimes: ['text/markdown', 'application/pdf', 'application/msword', 'text/plain'],
  },
  artifact: {
    maxBytes: 50 * 1024 * 1024,
    mimes: ['image/svg+xml', 'text/plain', 'application/json', 'model/step', 'application/octet-stream'],
  },
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: 'TOO_LARGE' | 'BAD_MIME' | 'NOT_FOUND' | 'BACKEND' | 'BAD_KEY',
  ) {
    super(message)
    this.name = 'StorageError'
  }
}

/**
 * 文件名规范化。
 *
 * 用户文件名绝不能直接拼进 objectKey：路径穿越、控制字符、超长名、
 * 以及 S3 上带 `..` 的 key 会让后续按前缀列举与删除出错。
 * 保留可读的词干，其余一律丢弃，再加 uuid 前缀保证唯一。
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^\w.\-一-龥]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+/, '')
    .slice(0, 100)
  return cleaned.length > 0 ? cleaned : 'file'
}

export function buildKey(parts: {
  projectId: string
  scope: string
  filename: string
}): string {
  return `projects/${parts.projectId}/${parts.scope}/${randomUUID()}-${sanitizeFilename(parts.filename)}`
}

/** key 形如 projects/<projectId>/<scope>/<name>；projectId 段就是归属依据 */
export const OBJECT_KEY_SHAPE = /^projects\/([^/]+)\//

/**
 * 用户提供的 objectKey 校验。
 *
 * 只有 projects/ 前缀下的对象归本应用管。放开这条限制，mock 存储下就是
 * 「读写服务器上任意路径」，S3 下就是「读写整个桶」。`..` 与 NUL 单独挡：
 * 前者能穿越出前缀，后者在部分文件 API 里会截断路径。
 *
 * 与 buildKey 配对使用 —— buildKey 负责生成合规的 key，这里负责在
 * key 来自请求体时把关。
 */
export function assertSafeObjectKey(key: string): void {
  if (!key.startsWith('projects/')) {
    throw new StorageError('objectKey 必须位于 projects/ 前缀下', 'BAD_KEY')
  }
  if (key.includes('..')) {
    throw new StorageError('objectKey 含非法路径片段', 'BAD_KEY')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new StorageError('objectKey 含控制字符', 'BAD_KEY')
  }
  if (!OBJECT_KEY_SHAPE.test(key)) {
    throw new StorageError('objectKey 缺少项目段', 'BAD_KEY')
  }
}

/** 从合规 key 里取项目 id；不合规返回 null */
export function projectIdFromKey(key: string): string | null {
  return OBJECT_KEY_SHAPE.exec(key)?.[1] ?? null
}

export interface PutResult {
  objectKey: string
  checksum: string
  sizeBytes: number
}

export interface PresignedUpload {
  /** 前端 PUT 到这个地址；mock 模式下是 api 的回落端点 */
  url: string
  objectKey: string
  method: 'PUT' | 'POST'
  headers: Record<string, string>
  expiresInSeconds: number
  /** mock 模式为 true，前端据此走 base64 回落 */
  isFallback: boolean
}

/** 对象元信息。取不到对象时返回 null，不抛。 */
export interface ObjectHead {
  sizeBytes: number
  mimeType: string | null
}

export interface StorageAdapter {
  readonly name: 'mock' | 's3'
  put(key: string, data: Buffer, mimeType: string): Promise<PutResult>
  get(key: string): Promise<Buffer | null>
  /**
   * 只取元信息，不拉内容。
   *
   * 直传完成回调要确认对象真的存在、大小真的合规，但 100MB 的 zip
   * 不该为了这个被整个拉进 API 进程 —— 内容留给 worker 解析时再读。
   */
  head(key: string): Promise<ObjectHead | null>
  delete(key: string): Promise<void>
  getSignedReadUrl(key: string, expiresSeconds?: number): Promise<string | null>
  createPresignedUpload(input: PresignInput): Promise<PresignedUpload>
}

export interface PresignInput {
  key: string
  mimeType: string
  /**
   * 客户端声明的**确切**字节数，调用方必须先用 validateUpload 校验过。
   *
   * 不是上限：它会被签进 content-length，上传时必须一字节不差。
   * 早先签的是 LIMITS 里的上限，于是任何一次真实上传的 content-length
   * 都对不上签名 —— MinIO 直接回 SignatureDoesNotMatch。
   */
  sizeBytes: number
  expiresSeconds?: number
}

/** 大小与 MIME 校验，两种 adapter 共用 */
export function validateUpload(kind: FileKindKey, mimeType: string, sizeBytes: number): void {
  const limit = LIMITS[kind]
  if (!limit.mimes.includes(mimeType)) {
    throw new StorageError(
      `不支持的文件类型 ${mimeType}，允许：${limit.mimes.join('、')}`,
      'BAD_MIME',
    )
  }
  if (sizeBytes > limit.maxBytes) {
    throw new StorageError(
      `文件过大 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB，上限 ${limit.maxBytes / 1024 / 1024}MB`,
      'TOO_LARGE',
    )
  }
}

// ---------------------------------------------------------------- mock

export class MockStorage implements StorageAdapter {
  readonly name = 'mock' as const
  private readonly memory = new Map<string, Buffer>()

  constructor(
    private readonly root = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage'),
    private readonly publicBase = process.env.API_PUBLIC_URL ?? 'http://localhost:3001',
  ) {}

  async put(key: string, data: Buffer, _mimeType: string): Promise<PutResult> {
    const checksum = createHash('sha256').update(data).digest('hex').slice(0, 16)
    try {
      const path = join(this.root, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    } catch {
      // 无盘环境（Railway 未挂卷）退回内存，重启即丢，仅供演示
      this.memory.set(key, data)
    }
    return { objectKey: key, checksum, sizeBytes: data.byteLength }
  }

  async get(key: string): Promise<Buffer | null> {
    const mem = this.memory.get(key)
    if (mem) return mem
    try {
      return await readFile(join(this.root, key))
    } catch {
      return null
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const mem = this.memory.get(key)
    if (mem) return { sizeBytes: mem.byteLength, mimeType: null }
    try {
      const st = await stat(join(this.root, key))
      return { sizeBytes: st.size, mimeType: null }
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key)
    await rm(join(this.root, key), { force: true }).catch(() => {})
  }

  async getSignedReadUrl(key: string): Promise<string | null> {
    // mock 没有签名概念，直接给 api 的读取端点
    return `${this.publicBase}/api/v1/files/${encodeURIComponent(key)}`
  }

  async createPresignedUpload(input: PresignInput): Promise<PresignedUpload> {
    return {
      url: `${this.publicBase}/api/v1/files/upload-fallback`,
      objectKey: input.key,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      expiresInSeconds: 600,
      isFallback: true,
    }
  }
}

// ---------------------------------------------------------------- s3 / r2

export const S3ConfigSchema = z.object({
  endpoint: z.string().url().optional(),
  region: z.string().default('auto'),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  /** R2 与 MinIO 需要 path-style */
  forcePathStyle: z.boolean().default(false),
})
export type S3Config = z.infer<typeof S3ConfigSchema>

export class S3Storage implements StorageAdapter {
  readonly name = 's3' as const
  // 延迟加载 SDK：mock 模式下不该为了不用的依赖付出启动开销
  private clientPromise: Promise<{ client: unknown; mod: typeof import('@aws-sdk/client-s3') }> | null =
    null

  constructor(private readonly config: S3Config) {}

  private async sdk() {
    this.clientPromise ??= (async () => {
      const mod = await import('@aws-sdk/client-s3')
      const client = new mod.S3Client({
        region: this.config.region,
        ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      })
      return { client, mod }
    })()
    return this.clientPromise
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<PutResult> {
    const { client, mod } = await this.sdk()
    const checksum = createHash('sha256').update(data).digest('hex').slice(0, 16)
    try {
      await (client as InstanceType<typeof mod.S3Client>).send(
        new mod.PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data,
          ContentType: mimeType,
        }),
      )
    } catch (err) {
      throw new StorageError(`S3 写入失败: ${(err as Error).message}`, 'BACKEND')
    }
    return { objectKey: key, checksum, sizeBytes: data.byteLength }
  }

  async get(key: string): Promise<Buffer | null> {
    const { client, mod } = await this.sdk()
    try {
      const res = await (client as InstanceType<typeof mod.S3Client>).send(
        new mod.GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
      if (!body?.transformToByteArray) return null
      return Buffer.from(await body.transformToByteArray())
    } catch {
      return null
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const { client, mod } = await this.sdk()
    try {
      const res = await (client as InstanceType<typeof mod.S3Client>).send(
        new mod.HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      return { sizeBytes: res.ContentLength ?? 0, mimeType: res.ContentType ?? null }
    } catch {
      // 404 与权限错误都走这里：调用方只需要知道「拿不到」
      return null
    }
  }

  async delete(key: string): Promise<void> {
    const { client, mod } = await this.sdk()
    await (client as InstanceType<typeof mod.S3Client>)
      .send(new mod.DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
      .catch(() => {})
  }

  async getSignedReadUrl(key: string, expiresSeconds = 3600): Promise<string | null> {
    const { client, mod } = await this.sdk()
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    try {
      return await getSignedUrl(
        client as InstanceType<typeof mod.S3Client>,
        new mod.GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { expiresIn: expiresSeconds },
      )
    } catch {
      return null
    }
  }

  /**
   * 直传 URL。浏览器直接 PUT 到对象存储，不经过 api ——
   * 100MB 的 zip 走 base64 过一遍 Node 进程是明确要避免的方案。
   *
   * 大小怎么防：把客户端声明的确切字节数签进 content-length。传多传少都会被
   * 对象存储以 SignatureDoesNotMatch 拒掉，字节根本落不了地。声明值本身由
   * 调用方先过 validateUpload。
   *
   * 这不是唯一一道：completeUpload 还会 head 一次，按真实大小复核并删掉超限对象。
   * 两道都要留 —— 签名这道防的是「传超了」，head 那道防的是「签的时候就撒谎」。
   */
  async createPresignedUpload(input: PresignInput): Promise<PresignedUpload> {
    const { client, mod } = await this.sdk()
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    const expiresInSeconds = input.expiresSeconds ?? 900

    const url = await getSignedUrl(
      client as InstanceType<typeof mod.S3Client>,
      new mod.PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        ContentType: input.mimeType,
        // 确切长度，不是上限 —— 见上面的注释
        ContentLength: input.sizeBytes,
      }),
      { expiresIn: expiresInSeconds },
    )

    return {
      url,
      objectKey: input.key,
      method: 'PUT',
      headers: { 'content-type': input.mimeType },
      expiresInSeconds,
      isFallback: false,
    }
  }
}

// ---------------------------------------------------------------- factory

export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if ((env.STORAGE_ADAPTER ?? 'mock') !== 's3') return new MockStorage()

  const parsed = S3ConfigSchema.safeParse({
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION || 'auto',
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  })

  if (!parsed.success) {
    // 配置不全时退回 mock 而不是崩溃：演示环境不该因为少一个变量就起不来。
    // 调用方通过 describeStorage() 能看到降级状态。
    console.warn(
      `[storage] STORAGE_ADAPTER=s3 但配置不全，已降级为 mock：` +
        parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    )
    return new MockStorage()
  }
  return new S3Storage(parsed.data)
}

export interface StorageStatus {
  adapter: 'mock' | 's3'
  /** STORAGE_ADAPTER 的原始值，可能与实际生效的 adapter 不同 */
  requested: string
  bucket: string | null
  /** adapter 不是它该是的样子：请求了 s3 却退回 mock，或生产环境在用 mock */
  degraded: boolean
  /** 生产环境在用 mock 存储 —— 这不是可接受的配置，见 docs/09 */
  productionUnsafe: boolean
  allowMockInProduction: boolean
  reason: string | null
}

/**
 * mock 存储为什么不能上生产：
 *
 * 落的是容器本地盘，Railway/Vercel 的容器随时重建，重启即丢；无盘时更是直接
 * 退回进程内存。它也没有对象级权限：读取要靠 api 自己开的 /files 路由代劳，
 * 而那条路由是给本地开发用的。用它跑生产不是「性能差一点」，是数据会消失。
 */
export function describeStorage(env: NodeJS.ProcessEnv = process.env): StorageStatus {
  const adapter = createStorage(env)
  const requested = env.STORAGE_ADAPTER ?? 'mock'
  const isProduction = env.NODE_ENV === 'production'
  // 大小写与首尾空格是纯粹的 UI 事故，不是意图上的歧义 —— 在 Railway 的
  // 变量框里填 `TRUE` 或末尾多一个空格，本意毫无疑问。以前严格比字面量
  // 'true'，这两种情况会被静默忽略，而报错信息**一模一样**，
  // 人会坚信自己已经设过了。
  const allowRaw = env.ALLOW_MOCK_STORAGE_IN_PRODUCTION
  const allowMockInProduction = (allowRaw ?? '').trim().toLowerCase() === 'true'
  const fellBack = adapter.name === 'mock' && requested === 's3'
  const mockInProduction = adapter.name === 'mock' && isProduction

  return {
    adapter: adapter.name,
    requested,
    bucket: env.S3_BUCKET ?? null,
    degraded: fellBack || mockInProduction,
    productionUnsafe: mockInProduction && !allowMockInProduction,
    allowMockInProduction,
    reason: fellBack
      ? 'STORAGE_ADAPTER=s3 但配置不全，已降级为 mock'
      : mockInProduction
        ? 'NODE_ENV=production 但存储是 mock：对象只在容器本地盘/内存，重启即丢'
        : null,
  }
}

/**
 * 启动前的硬校验。
 *
 * 选的是「启动失败」而不是「health 报 unhealthy」：生产上跑着 mock 存储，
 * 每一次上传都在制造将来会凭空消失的数据。让它起不来，运维一眼就知道该配什么；
 * 让它带病运行，问题要等到用户发现文件没了才暴露。
 *
 * 内置 Demo 这类明知故犯的场景用 ALLOW_MOCK_STORAGE_IN_PRODUCTION=true 显式豁免。
 */
export function assertStorageUsable(env: NodeJS.ProcessEnv = process.env): void {
  const s = describeStorage(env)
  if (!s.productionUnsafe) return

  // 把**实际读到的值**打出来。「我明明设了」是这条守卫最常见的卡点，
  // 而原因通常是设在了别的服务/别的环境、或者值写成了 `1`/`yes`。
  // 不打出来的话，两种情况的报错完全一样，只能靠猜。
  const seen = (name: string) => {
    const v = env[name]
    return v === undefined ? '(未设置)' : v === '' ? '(空字符串)' : JSON.stringify(v)
  }

  throw new StorageError(
    [
      'NODE_ENV=production 时不允许使用 mock 对象存储。',
      '对象会落在容器本地盘（无盘时退内存），容器重建即丢失，且没有对象级权限。',
      '',
      '二选一：',
      '  1) 配置真实对象存储：STORAGE_ADAPTER=s3 + S3_ENDPOINT / S3_BUCKET /',
      '     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY（R2、S3、MinIO 均可，见 docs/09）',
      '  2) 明知故犯（仅内置 Demo）：ALLOW_MOCK_STORAGE_IN_PRODUCTION=true',
      '',
      '注意：api 与 worker 是两个独立服务，**两边都要设**，',
      '而且要设在当前这个环境（Railway 的变量是按 环境×服务 分开的）。',
      '',
      '本进程实际读到的值：',
      `  NODE_ENV                          = ${seen('NODE_ENV')}`,
      `  STORAGE_ADAPTER                   = ${seen('STORAGE_ADAPTER')}`,
      `  ALLOW_MOCK_STORAGE_IN_PRODUCTION  = ${seen('ALLOW_MOCK_STORAGE_IN_PRODUCTION')}`,
      `  S3_BUCKET                         = ${seen('S3_BUCKET')}`,
      '',
      '豁免开关只认 true（不区分大小写、忽略首尾空格）。上面若显示 "1" / "yes"',
      '这类值，说明设了但没被认作开启 —— 改成 true 即可。',
      '若显示 (未设置)，说明这个进程根本没读到它：多半设在了别的服务或别的环境。',
    ].join('\n'),
    'BACKEND',
  )
}
