import { Body, Controller, Get, Headers, Post } from '@nestjs/common'
import { z } from 'zod'
import { AuthService } from './auth.service'

/** 从 Authorization: Bearer <token> 里取 token */
export const bearer = (h: string | undefined): string | undefined =>
  h?.startsWith('Bearer ') ? h.slice(7) : undefined

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: unknown) {
    const { email, name } = z
      .object({ email: z.string().email().max(200), name: z.string().max(60).optional() })
      .parse(body)
    return this.auth.login(email, name)
  }

  /** 当前登录态；未登录返回 null 而不是 401，前端据此决定显示登录入口 */
  @Get('me')
  async me(@Headers('authorization') authorization?: string) {
    return { user: await this.auth.verify(bearer(authorization)) }
  }
}
