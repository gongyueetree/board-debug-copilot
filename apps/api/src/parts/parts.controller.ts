import { Body, Controller, Get, Post, Query } from '@nestjs/common'
import { z } from 'zod'
import { PartsService } from './parts.service'

@Controller('parts')
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    const input = z.object({ q: z.string().min(1).max(120), limit: z.coerce.number().min(1).max(20).optional() })
      .parse({ q, limit })
    return this.parts.search(input.q, input.limit ?? 5)
  }

  @Get('lookup')
  lookup(@Query('partNumber') partNumber: string) {
    return this.parts.lookup(z.string().min(1).max(60).parse(partNumber))
  }

  /** 把内置常识库写入数据库；配了 embedding 就顺带生成向量 */
  @Post('seed')
  seed(@Body() _body: unknown) {
    return this.parts.seedBuiltin()
  }
}
