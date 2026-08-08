import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@app/db'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect()
      this.logger.log('数据库已连接')
    } catch (err) {
      // 数据库不可用不应让整个 api 起不来：只读端点会返回 503，/health 仍然 200
      this.logger.error(`数据库连接失败：${(err as Error).message}`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
