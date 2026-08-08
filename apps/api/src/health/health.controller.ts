import { Controller, Get } from '@nestjs/common'
import { HealthResponseSchema, type HealthResponse } from '@app/contracts'
import { describeProvider } from '@app/ai'

@Controller()
export class HealthController {
  @Get('health')
  health(): HealthResponse & { llm: ReturnType<typeof describeProvider> } {
    return {
      ...HealthResponseSchema.parse({
        status: 'ok',
        service: 'board-debug-copilot-api',
        version: process.env.npm_package_version ?? '0.1.0',
        mockMode: process.env.MOCK_MODE === 'true',
        timestamp: new Date().toISOString(),
      }),
      llm: describeProvider(),
    }
  }
}
