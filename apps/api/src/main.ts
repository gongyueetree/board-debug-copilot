import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ZodExceptionFilter } from './common/zod-exception.filter'

async function bootstrap() {
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
