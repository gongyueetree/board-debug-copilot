import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common'
import { StepStatusSchema } from '@app/contracts'
import { z } from 'zod'
import { MutationsService } from './mutations.service'
import { ReportService } from './report.service'

const RegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
})

@Controller()
export class MutationsController {
  constructor(
    private readonly mutations: MutationsService,
    private readonly reports: ReportService,
  ) {}

  @Post('projects/:id/photos')
  uploadPhoto(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        mimeType: z.string(),
        base64: z.string().min(1),
        side: z.enum(['TOP', 'BOTTOM']).optional(),
      })
      .parse(body)
    return this.mutations.uploadPhoto(id, input)
  }

  @Post('photos/:photoId/annotations')
  createAnnotation(@Param('photoId') photoId: string, @Body() body: unknown) {
    const input = z
      .object({
        kind: z.enum(['component', 'solder', 'damage', 'question']),
        region: RegionSchema,
        note: z.string().max(500).optional(),
        componentRef: z.string().max(16).optional(),
        createdBy: z.string().max(40).optional(),
      })
      .parse(body)
    return this.mutations.createAnnotation(photoId, input)
  }

  @Delete('annotations/:id')
  deleteAnnotation(@Param('id') id: string) {
    return this.mutations.deleteAnnotation(id)
  }

  @Post('projects/:id/captures')
  saveCapture(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        label: z.string().max(120).optional(),
        kind: z.enum(['OSCILLOSCOPE', 'FFT', 'BODE', 'LOGIC', 'DMM', 'POWER']).optional(),
        netName: z.string().optional(),
        debugStepId: z.string().optional(),
        hardwareSetup: z.record(z.string(), z.unknown()),
        measurements: z.record(z.string(), z.unknown()),
        waveform: z
          .object({ ch1: z.array(z.number()), ch2: z.array(z.number()), fs: z.number() })
          .optional(),
      })
      .parse(body)
    return this.mutations.saveCapture(id, input)
  }

  @Patch('debug-steps/:id')
  updateStep(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        status: StepStatusSchema.optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        objective: z.string().max(400).optional(),
        expectedResult: z.string().max(400).optional(),
      })
      .parse(body)
    return this.mutations.updateStep(id, input)
  }

  @Post('projects/:id/debug-steps')
  createStep(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        groupId: z.string().optional(),
        title: z.string().min(1).max(80),
        objective: z.string().max(400).optional(),
        toolHint: z.enum(['万用表', '示波器', 'ADALM2000', '逻辑分析仪', '目视']).optional(),
        estimateMin: z.number().int().min(1).max(60).optional(),
      })
      .parse(body)
    return this.mutations.createCustomStep(id, input)
  }

  @Post('projects/:id/reports')
  generateReport(@Param('id') id: string) {
    return this.reports.generate(id)
  }

  @Get('projects/:id/ai-thread/:mode')
  thread(@Param('id') id: string, @Param('mode') mode: string) {
    return this.reports.thread(id, mode)
  }
}
