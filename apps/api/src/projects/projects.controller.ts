import { Controller, Get, Param } from '@nestjs/common'
import {
  ActivityItemSchema,
  AiDiagnosisSchema,
  BoardPhotoSchema,
  CaptureSummarySchema,
  DebugPlanSchema,
  DesignBundleSchema,
  ProjectDetailSchema,
  ProjectSummarySchema,
  ReportSchema,
  type ActivityItem,
  type AiDiagnosis,
  type BoardPhoto,
  type CaptureSummary,
  type DebugPlan,
  type DesignBundle,
  type ProjectDetail,
  type ProjectSummary,
  type Report,
} from '@app/contracts'
import { z } from 'zod'
import { ProjectsService } from './projects.service'

/**
 * 只读端点。每个响应都过 Zod 校验（P1 验收要求），
 * 校验失败会抛 500 而不是把脏数据传给前端。
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(): Promise<ProjectSummary[]> {
    return z.array(ProjectSummarySchema).parse(await this.projects.list())
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<ProjectDetail> {
    return ProjectDetailSchema.parse(await this.projects.detail(id))
  }

  @Get(':id/design')
  async design(@Param('id') id: string): Promise<DesignBundle> {
    return DesignBundleSchema.parse(await this.projects.design(id))
  }

  @Get(':id/captures')
  async captures(@Param('id') id: string): Promise<CaptureSummary[]> {
    return z.array(CaptureSummarySchema).parse(await this.projects.captures(id))
  }

  @Get(':id/debug-steps')
  async plan(@Param('id') id: string): Promise<DebugPlan> {
    return DebugPlanSchema.parse(await this.projects.plan(id))
  }

  @Get(':id/activity')
  async activity(@Param('id') id: string): Promise<ActivityItem[]> {
    return z.array(ActivityItemSchema).parse(await this.projects.activity(id))
  }

  @Get(':id/diagnoses/latest')
  async latestDiagnosis(@Param('id') id: string): Promise<AiDiagnosis> {
    return AiDiagnosisSchema.parse(await this.projects.latestDiagnosis(id))
  }

  @Get(':id/photos')
  async photos(@Param('id') id: string): Promise<BoardPhoto[]> {
    return z.array(BoardPhotoSchema).parse(await this.projects.photos(id))
  }

  @Get(':id/reports/latest')
  async latestReport(@Param('id') id: string): Promise<Report> {
    return ReportSchema.parse(await this.projects.latestReport(id))
  }
}
