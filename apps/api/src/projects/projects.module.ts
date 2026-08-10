import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { CloneService } from './clone.service'
import { MutationsController } from './mutations.controller'
import { MutationsService } from './mutations.service'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'
import { ReportService } from './report.service'

@Module({
  controllers: [ProjectsController, MutationsController],
  providers: [ProjectsService, MutationsService, ReportService, CloneService, StorageService],
  exports: [ProjectsService, StorageService],
})
export class ProjectsModule {}
