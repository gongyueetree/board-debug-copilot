import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  StorageError,
  assertSafeObjectKey,
  assertStorageUsable,
  buildKey,
  describeStorage,
  projectIdFromKey,
  sanitizeFilename,
  validateUpload,
} from '../src'

describe('文件名 sanitize', () => {
  it('去掉路径分隔符，只留文件名', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Windows\\evil.zip')).toBe('evil.zip')
  })

  it('保留中文与常见字符', () => {
    expect(sanitizeFilename('传感器板 v2.zip')).toBe('传感器板_v2.zip')
  })

  it('折叠连续点号，挡住 ..', () => {
    expect(sanitizeFilename('a..b..zip')).toBe('a.b.zip')
  })

  it('去掉开头的点与下划线，避免隐藏文件', () => {
    expect(sanitizeFilename('...hidden')).toBe('hidden')
  })

  it('超长名截断', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(100)
  })

  it('剥掉控制字符与 DEL', () => {
    // 这条规则的正则里曾经嵌着真实的 NUL 字节，git 把整个源文件当二进制，
    // diff 看不见改动。这里用 fromCharCode 构造，避免再往源码里塞控制字节。
    const ctl = (...codes: number[]) => String.fromCharCode(...codes)
    expect(sanitizeFilename(`a${ctl(0)}b${ctl(31)}c${ctl(127)}.zip`)).toBe('abc.zip')
    expect(sanitizeFilename(ctl(0, 31, 127))).toBe('file')
  })

  it('全是非法字符时给出兜底名', () => {
    expect(sanitizeFilename('///')).toBe('file')
  })
})

describe('objectKey 构造', () => {
  it('带项目前缀与 uuid，用户文件名不直接落进 key', () => {
    const key = buildKey({ projectId: 'p1', scope: 'kicad', filename: '../evil.zip' })
    expect(key.startsWith('projects/p1/kicad/')).toBe(true)
    expect(key).not.toContain('..')
    expect(key.endsWith('evil.zip')).toBe(true)
  })

  it('同名文件不会撞 key', () => {
    const a = buildKey({ projectId: 'p1', scope: 'x', filename: 'a.zip' })
    const b = buildKey({ projectId: 'p1', scope: 'x', filename: 'a.zip' })
    expect(a).not.toBe(b)
  })
})

describe('上传校验', () => {
  it('按类型限制大小', () => {
    expect(() => validateUpload('photo', 'image/png', 21 * 1024 * 1024)).toThrow(StorageError)
    expect(() => validateUpload('photo', 'image/png', 1024)).not.toThrow()
  })

  it('拒绝错误 MIME 并说明允许哪些', () => {
    try {
      validateUpload('photo', 'text/plain', 1024)
      expect.unreachable('应当抛出')
    } catch (e) {
      expect((e as StorageError).code).toBe('BAD_MIME')
      expect((e as Error).message).toContain('image/')
    }
  })

  it('限制值与文档一致', () => {
    expect(LIMITS.zip.maxBytes).toBe(100 * 1024 * 1024)
    expect(LIMITS.photo.maxBytes).toBe(20 * 1024 * 1024)
    expect(LIMITS.waveform.maxBytes).toBe(50 * 1024 * 1024)
    expect(LIMITS.report.maxBytes).toBe(20 * 1024 * 1024)
  })

  it('超限错误里报出实际大小', () => {
    try {
      validateUpload('zip', 'application/zip', 200 * 1024 * 1024)
    } catch (e) {
      expect((e as Error).message).toMatch(/200\.0MB/)
    }
  })
})

describe('objectKey 安全校验', () => {
  // 这些是 FilesController 的读写路由唯一的路径边界。放开任何一条，
  // mock 下就是「读写服务器任意路径」，S3 下就是「读写整个桶」。
  const ok = 'projects/00000000-0000-0000-0000-0000000000d1/kicad/x.zip'

  it('合规 key 通过并能取出项目 id', () => {
    expect(() => assertSafeObjectKey(ok)).not.toThrow()
    expect(projectIdFromKey(ok)).toBe('00000000-0000-0000-0000-0000000000d1')
  })

  it.each([
    ['非 projects/ 前缀', 'etc/passwd'],
    ['伪装前缀', 'projectsX/p1/a.zip'],
    ['上跳目录', 'projects/p1/../../etc/passwd'],
    ['前缀后直接上跳', 'projects/../secret'],
    ['只有前缀没有项目段', 'projects/'],
    ['绝对路径', '/projects/p1/a.zip'],
  ])('%s 被拒', (_label, key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(StorageError)
  })

  it('含 NUL 或控制字符被拒', () => {
    const ctl = (c: number) => String.fromCharCode(c)
    expect(() => assertSafeObjectKey(`projects/p1/a${ctl(0)}.zip`)).toThrow(StorageError)
    expect(() => assertSafeObjectKey(`projects/p1/a${ctl(31)}.zip`)).toThrow(StorageError)
    expect(() => assertSafeObjectKey(`projects/p1/a${ctl(127)}.zip`)).toThrow(StorageError)
  })

  it('不同的越界方式给出不同的错误信息', () => {
    // 前缀检查会被后面的形状检查兜住，两条都留着是为了错误信息可操作：
    // 「不在 projects/ 下」和「缺少项目段」要修的东西不一样。
    // 这条测试也让「删掉前缀检查」变成可观测的行为变化。
    expect(() => assertSafeObjectKey('etc/passwd')).toThrow(/projects\/ 前缀/)
    expect(() => assertSafeObjectKey('projects/')).toThrow(/项目段/)
    expect(() => assertSafeObjectKey('projects/p1/../x')).toThrow(/非法路径片段/)
  })

  it('拒绝时 code 是 BAD_KEY，调用方据此回 403 而不是 500', () => {
    try {
      assertSafeObjectKey('etc/passwd')
      throw new Error('应该抛出')
    } catch (err) {
      expect((err as StorageError).code).toBe('BAD_KEY')
    }
  })
})

describe('生产环境禁用 mock 存储', () => {
  const base = { STORAGE_ADAPTER: 'mock' } as NodeJS.ProcessEnv

  it('开发环境用 mock 完全正常', () => {
    const s = describeStorage({ ...base, NODE_ENV: 'development' })
    expect(s.adapter).toBe('mock')
    expect(s.degraded).toBe(false)
    expect(s.productionUnsafe).toBe(false)
    expect(() => assertStorageUsable({ ...base, NODE_ENV: 'development' })).not.toThrow()
  })

  it('生产 + mock 且未显式豁免时拒绝启动', () => {
    const env = { ...base, NODE_ENV: 'production' }
    const s = describeStorage(env)
    expect(s.productionUnsafe).toBe(true)
    expect(s.degraded).toBe(true)
    expect(() => assertStorageUsable(env)).toThrow(StorageError)
    // 报错必须给出可执行的修法，否则运维只能猜
    expect(() => assertStorageUsable(env)).toThrow(/STORAGE_ADAPTER=s3/)
    expect(() => assertStorageUsable(env)).toThrow(/ALLOW_MOCK_STORAGE_IN_PRODUCTION/)
  })

  it('显式豁免后可启动，但仍标记为 degraded', () => {
    const env = { ...base, NODE_ENV: 'production', ALLOW_MOCK_STORAGE_IN_PRODUCTION: 'true' }
    expect(() => assertStorageUsable(env)).not.toThrow()
    const s = describeStorage(env)
    expect(s.productionUnsafe).toBe(false)
    // 豁免的是「不许启动」，不是「这是个好配置」
    expect(s.degraded).toBe(true)
    expect(s.allowMockInProduction).toBe(true)
  })

  it('豁免开关容忍大小写与首尾空格', () => {
    // 在 Railway 的变量框里填 TRUE 或末尾多一个空格，本意毫无疑问。
    // 以前严格比字面量 'true'，这两种会被静默忽略，而报错信息一模一样 ——
    // 人会坚信自己已经设过了。
    for (const v of ['true', 'TRUE', 'True', ' true ', 'true\n']) {
      const env = { ...base, NODE_ENV: 'production', ALLOW_MOCK_STORAGE_IN_PRODUCTION: v }
      expect(describeStorage(env).productionUnsafe, `值 ${JSON.stringify(v)}`).toBe(false)
    }
  })

  it('但不认 1 / yes / 空 —— 那些是真有歧义的', () => {
    for (const v of ['1', 'yes', 'on', '']) {
      const env = { ...base, NODE_ENV: 'production', ALLOW_MOCK_STORAGE_IN_PRODUCTION: v }
      expect(describeStorage(env).productionUnsafe, `值 ${JSON.stringify(v)}`).toBe(true)
    }
  })

  it('报错时打出实际读到的值 —— 「我明明设了」要能一眼看出为什么没生效', () => {
    const env = { ...base, NODE_ENV: 'production', ALLOW_MOCK_STORAGE_IN_PRODUCTION: '1' }
    try {
      assertStorageUsable(env)
      throw new Error('应该抛出')
    } catch (err) {
      const msg = (err as Error).message
      // 设成 1 时要看到它的字面值，而不是又一遍通用提示
      expect(msg).toContain('ALLOW_MOCK_STORAGE_IN_PRODUCTION  = "1"')
      expect(msg).toContain('NODE_ENV                          = "production"')
      expect(msg).toContain('两边都要设')
    }
  })

  it('完全没设时显示 (未设置)，与「设了但值不对」区分开', () => {
    try {
      assertStorageUsable({ ...base, NODE_ENV: 'production' })
      throw new Error('应该抛出')
    } catch (err) {
      expect((err as Error).message).toContain('ALLOW_MOCK_STORAGE_IN_PRODUCTION  = (未设置)')
    }
  })

  it('请求 s3 但配置不全时降级并标记，生产下同样拒绝启动', () => {
    const env = { STORAGE_ADAPTER: 's3', NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const s = describeStorage(env)
    expect(s.adapter).toBe('mock')
    expect(s.requested).toBe('s3')
    expect(s.degraded).toBe(true)
    expect(() => assertStorageUsable(env)).toThrow(StorageError)
  })

  it('配置齐全的 s3 在生产下正常', () => {
    const env = {
      STORAGE_ADAPTER: 's3',
      NODE_ENV: 'production',
      S3_BUCKET: 'bdc',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    } as NodeJS.ProcessEnv
    const s = describeStorage(env)
    expect(s.adapter).toBe('s3')
    expect(s.degraded).toBe(false)
    expect(s.productionUnsafe).toBe(false)
  })
})
