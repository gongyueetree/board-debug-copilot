import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'
import { ZodError } from 'zod'

/**
 * Zod 校验失败 → 400。
 *
 * 不装这个过滤器时 ZodError 会冒泡成 500，用户看到「Internal server error」
 * 而不是「文件过大」。校验失败是客户端错误，必须如实回 400 并说明哪个字段不对。
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(error: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'ValidationError',
      message: error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
}
