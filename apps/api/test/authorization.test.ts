/**
 * 写操作鉴权的契约测试。
 *
 * 不起 Nest 容器：这里要守的是「每个写端点都反查项目归属再 guard」这条规则，
 * 而漏掉 guard 恰恰是源码层面的疏忽（PATCH /debug-steps/:id 就漏过）。
 * 所以直接对 controller 源码做结构断言，比跑一遍 HTTP 更能挡住同类回归。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '../src/projects/mutations.controller.ts')
const source = readFileSync(SRC, 'utf8')

/** 取出某个路由装饰器到下一个装饰器之间的方法体 */
function handlerFor(decorator: string): string {
  const start = source.indexOf(decorator)
  if (start === -1) throw new Error(`找不到路由 ${decorator}`)
  const rest = source.slice(start + decorator.length)
  const next = rest.search(/\n  @(Post|Get|Patch|Delete)\(/)
  return next === -1 ? rest : rest.slice(0, next)
}

const WRITE_ROUTES = [
  "@Post('projects/:id/photos')",
  "@Post('photos/:photoId/annotations')",
  "@Delete('annotations/:id')",
  "@Post('projects/:id/captures')",
  "@Patch('debug-steps/:id')",
  "@Post('projects/:id/debug-steps')",
  "@Post('projects/:id/reports')",
]

describe('写操作鉴权', () => {
  it.each(WRITE_ROUTES)('%s 调用了 guard', (route) => {
    expect(handlerFor(route)).toContain('this.guard(')
  })

  it.each(WRITE_ROUTES)('%s 接收 authorization header', (route) => {
    expect(handlerFor(route)).toContain('authorization')
  })

  it('id 不含项目信息的路由会先反查归属', () => {
    // 这三个路由的路径参数是 photo/annotation/step 的 id，
    // 必须反查 projectId 才能判断归属
    expect(handlerFor("@Patch('debug-steps/:id')")).toContain('projectIdForStep')
    expect(handlerFor("@Delete('annotations/:id')")).toContain('projectIdForAnnotation')
    expect(handlerFor("@Post('photos/:photoId/annotations')")).toContain('projectIdForPhoto')
  })

  it('guard 会把未登录用户交给 assertCanWrite 判定', () => {
    const guard = handlerFor('private async guard(')
    expect(guard).toContain('this.auth.verify(')
    expect(guard).toContain('assertCanWrite')
  })
})

describe('归属规则', () => {
  const auth = readFileSync(join(__dirname, '../src/auth/auth.service.ts'), 'utf8')

  it('公共 Demo（userId 为空）拒绝一切写入', () => {
    expect(auth).toContain('project.userId === null')
    expect(auth).toMatch(/userId === null[\s\S]{0,200}ForbiddenException/)
  })

  it('他人项目拒绝写入', () => {
    expect(auth).toMatch(/project\.userId !== user\.id[\s\S]{0,120}ForbiddenException/)
  })
})
