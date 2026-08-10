import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { assertStorageUsable, describeStorage } from '@app/storage'
import { AppModule } from './app.module'
import { ZodExceptionFilter } from './common/zod-exception.filter'

/**
 * 存储配置在建容器之前就检查掉。
 *
 * 放在 NestFactory.create 之前是有意的：等 Nest 起来再报错，日志里会先刷一屏
 * 模块初始化，真正的原因埋在中间。这里失败就是启动失败，第一行就是原因。
 */
function checkStorage() {
  const s = describeStorage()
  try {
    assertStorageUsable()
  } catch (err) {
    Logger.error(`\n${(err as Error).message}\n`, 'Bootstrap')
    process.exit(1)
  }
  if (s.degraded) {
    Logger.warn(`存储降级：${s.reason ?? '未知原因'}（adapter=${s.adapter}）`, 'Bootstrap')
  }
}

async function bootstrap() {
  checkStorage()
  const app = await NestFactory.create(AppModule)

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  app.enableCors({
    origin: origins.includes('*') ? true : origins,
    credentials: true,
  })

  // 校验失败是客户端错误，必须回 400 而不是冒泡成 500
  app.useGlobalFilters(new ZodExceptionFilter())

  app.setGlobalPrefix('api/v1', { exclude: ['health'] })

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
  await app.listen(port, '0.0.0.0')

  Logger.log(`api listening on :${port} (MOCK_MODE=${process.env.MOCK_MODE ?? 'false'})`, 'Bootstrap')
}

void bootstrap()
