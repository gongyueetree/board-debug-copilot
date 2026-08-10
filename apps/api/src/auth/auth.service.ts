import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'

export interface SessionUser {
  id: string
  email: string | null
  name: string | null
}

/**
 * 简单登录（docs/00 §1.2：企业级多租户后置，先做单用户/简单登录）。
 *
 * 无密码：输入邮箱即建账号并签发 token。这不是给公网多租户用的，
 * 而是让「项目归属」和「写操作鉴权」有一个真实的主体，
 * 后续换成 OAuth 或企业 SSO 时只需替换 issue()，其余不动。
 *
 * token 是 HMAC 签名的 `userId.exp.sig`，不查库即可验签。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  private readonly secret: string
  private readonly ttlMs = 30 * 24 * 3600 * 1000

  constructor(private readonly prisma: PrismaService) {
    const s = process.env.AUTH_SECRET
    if (!s) {
      // 没配就随机生成：重启后旧 token 失效，但不会因为忘配变成人人可伪造
      this.secret = randomUUID()
      this.logger.warn('AUTH_SECRET 未配置，已用随机密钥，重启后登录态失效')
    } else {
      this.secret = s
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }

  async login(email: string, name?: string): Promise<{ token: string; user: SessionUser }> {
    const normalized = email.trim().toLowerCase()
    const user = await this.prisma.user.upsert({
      where: { email: normalized },
      update: name ? { name } : {},
      create: { email: normalized, name: name ?? normalized.split('@')[0] },
    })

    const exp = Date.now() + this.ttlMs
    const payload = `${user.id}.${exp}`
    return {
      token: `${payload}.${this.sign(payload)}`,
      user: { id: user.id, email: user.email, name: user.name },
    }
  }

  /** 验签 + 查库。token 无效或用户已删除都当未登录。 */
  async verify(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [userId, expStr, sig] = parts as [string, string, string]

    const expected = this.sign(`${userId}.${expStr}`)
    // 定长比较，避免签名比对被计时侧信道利用
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    if (Number(expStr) < Date.now()) return null

    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    return user ? { id: user.id, email: user.email, name: user.name } : null
  }

  async require(token: string | undefined): Promise<SessionUser> {
    const user = await this.verify(token)
    if (!user) throw new UnauthorizedException('未登录或登录已过期')
    return user
  }

  /**
   * 项目归属校验。
   *
   * userId 为空的项目是公共 demo：任何人可读，但**任何人都不能写**。
   * 早先的版本允许匿名写入，演示很方便，但任何访客都能污染所有人看到的
   * 那份数据。想动手就先克隆一份到自己名下。
   *
   * 内置 Demo 的「未登录也能完整演示」由只读路径保证 —— 6 个页面全部可看。
   */
  async assertCanWrite(projectId: string, user: SessionUser | null): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project) return

    if (project.userId === null) {
      throw new ForbiddenException(
        '公共 Demo 项目只读。点「复制到我的项目」克隆一份后即可修改。',
      )
    }
    if (!user) throw new UnauthorizedException('未登录或登录已过期')
    if (project.userId !== user.id) throw new ForbiddenException('无权修改他人项目')
  }
}
