import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

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

  app.setGlobalPrefix('api/v1', { exclude: ['health'] })

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
  await app.listen(port, '0.0.0.0')

  Logger.log(`api listening on :${port} (MOCK_MODE=${process.env.MOCK_MODE ?? 'false'})`, 'Bootstrap')
}

void bootstrap()
