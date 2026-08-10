import { describe, expect, it } from 'vitest'
import { LIMITS, StorageError, buildKey, sanitizeFilename, validateUpload } from '../src'

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
