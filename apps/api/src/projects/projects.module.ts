import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { CloneService } from './clone.service'
import { LabSightWorkflowController } from './labsight-workflow.controller'
import { LabSightWorkflowService } from './labsight-workflow.service'
import { MutationsController } from './mutations.controller'
import { MutationsService } from './mutations.service'
import { PhotoUploadService } from './photo-upload.service'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'
import { ReportService } from './report.service'

@Module({
  controllers: [ProjectsController, MutationsController, LabSightWorkflowController],
  providers: [
    ProjectsService,
    MutationsService,
    PhotoUploadService,
    ReportService,
    CloneService,
    StorageService,
    LabSightWorkflowService,
  ],
  exports: [ProjectsService, StorageService, LabSightWorkflowService],
})
export class ProjectsModule {}
