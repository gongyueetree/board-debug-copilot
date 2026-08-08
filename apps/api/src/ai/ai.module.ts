import { Module } from '@nestjs/common'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { DesignGraphService } from './design-graph.service'

@Module({
  controllers: [AiController],
  providers: [AiService, DesignGraphService],
  exports: [AiService, DesignGraphService],
})
export class AiModule {}
