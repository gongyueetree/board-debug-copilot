import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'
import { HealthResponseSchema, type HealthResponse } from '@app/contracts'
import { describeProvider } from '@app/ai'
import { describeStorage, type StorageStatus } from '@app/storage'
import type { PartsHealth } from '@app/parts'
import { PartsProviderService } from '../parts/parts.provider'

type Health = HealthResponse & {
  llm: ReturnType<typeof describeProvider>
  storage: StorageStatus
  parts: PartsHealth
}

@Controller()
export class HealthController {
  constructor(private readonly parts: PartsProviderService) {}

  /**
   * 健康检查同时是配置检查。
   *
   * 三个外部依赖的降级状态放在一起，形状也保持一致（都有 degraded + 原因）——
   * 运维不该为了看「AI 降级了没」和「器件库降级了没」去读两种不同的结构。
   *
   * 存储降级不会让 API 崩，但它必须在这里可见；生产 + mock 存储在 main.ts
   * 里就已经拒绝启动，这里能看到的只剩显式豁免的情况。
   */
  @Get('health')
  async health(@Res() res: Response): Promise<void> {
    const storage = describeStorage()
    const parts = await this.parts.describe()

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
      // 器件库降级不影响可用性（会退到内置常识参数），所以不进 status 判定，
      // 但必须报出来 —— 参数不准会安静地降低 AI 输出质量，没有别的信号。
      parts,
    }
    // productionUnsafe 只会在 main.ts 的启动校验被绕过时出现（例如直接 import
    // AppModule 起服务）。真出现了就该让编排器看到 503，而不是绿灯。
    res.status(storage.productionUnsafe ? 503 : 200).json(body)
  }
}
