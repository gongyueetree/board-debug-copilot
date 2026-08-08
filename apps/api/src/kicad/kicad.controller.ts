import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { KicadService } from './kicad.service'

@Controller('projects/:id/kicad')
export class KicadController {
  constructor(
    private readonly kicad: KicadService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('upload')
  upload(@Param('id') id: string, @Body() body: unknown) {
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        base64: z.string().min(1),
        mimeType: z.string().optional(),
      })
      .parse(body)
    return this.kicad.uploadAndParse(id, input)
  }

  /** 解析状态与 parseLog，前端据此显示失败原因而不是一个空白页 */
  @Get('status')
  async status(@Param('id') id: string) {
    const [project, files] = await Promise.all([
      this.prisma.project.findUnique({ where: { id }, select: { status: true } }),
      this.prisma.projectFile.findMany({
        where: { projectId: id, kind: 'KICAD_ZIP' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ])
    return {
      status: project?.status ?? 'CREATED',
      uploads: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        parseStatus: f.parseStatus,
        parseLog: f.parseLog,
        createdAt: f.createdAt.toISOString(),
      })),
    }
  }
}
