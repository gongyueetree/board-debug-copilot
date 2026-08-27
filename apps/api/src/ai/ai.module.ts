import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { AssemblyInspectionService } from './assembly-inspection.service'
import { DesignGraphService } from './design-graph.service'

@Module({
  controllers: [AiController],
  providers: [AiService, AssemblyInspectionService, DesignGraphService, StorageService],
  exports: [AiService, AssemblyInspectionService, DesignGraphService],
})
export class AiModule {}
