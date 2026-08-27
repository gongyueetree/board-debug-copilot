import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'
import { AssemblyAlignmentService } from './assembly-alignment.service'
import { AssemblyInspectionService } from './assembly-inspection.service'
import { AssemblySourceService } from './assembly-source.service'
import { DesignGraphService } from './design-graph.service'

@Module({
  controllers: [AiController],
  providers: [
    AiService,
    AssemblySourceService,
    AssemblyAlignmentService,
    AssemblyInspectionService,
    DesignGraphService,
    StorageService,
  ],
  exports: [AiService, AssemblyAlignmentService, AssemblyInspectionService, DesignGraphService],
})
export class AiModule {}
