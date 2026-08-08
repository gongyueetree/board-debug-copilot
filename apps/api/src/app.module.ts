import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AiModule } from './ai/ai.module'
import { AuthModule } from './auth/auth.module'
import { HealthController } from './health/health.controller'
import { KicadModule } from './kicad/kicad.module'
import { PartsModule } from './parts/parts.module'
import { PrismaModule } from './prisma/prisma.module'
import { ProjectsModule } from './projects/projects.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProjectsModule,
    AiModule,
    KicadModule,
    PartsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
