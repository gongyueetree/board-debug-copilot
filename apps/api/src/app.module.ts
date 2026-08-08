import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module'
import { HealthController } from './health/health.controller'
import { PrismaModule } from './prisma/prisma.module'
import { ProjectsModule } from './projects/projects.module'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, ProjectsModule, AiModule],
  controllers: [HealthController],
})
export class AppModule {}
