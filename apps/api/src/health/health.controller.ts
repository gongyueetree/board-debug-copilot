import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'
import { HealthResponseSchema, type HealthResponse } from '@app/contracts'
import { describeProvider } from '@app/ai'
import { describeStorage, type StorageStatus } from '@app/storage'

type Health = HealthResponse & {
  llm: ReturnType<typeof describeProvider>
  storage: StorageStatus
}

@Controller()
export class HealthController {
  /**
   * 健康检查同时是配置检查。
   *
   * 存储降级不会让 API 崩，但它必须在这里可见 —— 否则「文件传上去了，
   * 过几天没了」这类问题要等到用户报障才发现。生产 + mock 存储在
   * main.ts 里就已经拒绝启动，这里能看到的只剩显式豁免的情况。
   */
  @Get('health')
  health(@Res() res: Response): void {
    const storage = describeStorage()
    const body: Health = {
      ...HealthResponseSchema.parse({
        status: storage.productionUnsafe ? 'unhealthy' : 'ok',
        service: 'board-debug-copilot-api',
        version: process.env.npm_package_version ?? '0.1.0',
        mockMode: process.env.MOCK_MODE === 'true',
        timestamp: new Date().toISOString(),
      }),
      llm: describeProvider(),
      storage,
    }
    // productionUnsafe 只会在 main.ts 的启动校验被绕过时出现（例如直接 import
    // AppModule 起服务）。真出现了就该让编排器看到 503，而不是绿灯。
    res.status(storage.productionUnsafe ? 503 : 200).json(body)
  }
}
