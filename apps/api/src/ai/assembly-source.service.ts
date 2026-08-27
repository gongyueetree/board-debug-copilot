import { Injectable, NotFoundException } from '@nestjs/common'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pickRoot, safeUnzip } from '@app/kicad'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

@Injectable()
export class AssemblySourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async loadPcb(projectId: string): Promise<{ filename: string; text: string }> {
    const zipFile = await this.prisma.projectFile.findFirst({
      where: { projectId, kind: 'KICAD_ZIP' },
      orderBy: { createdAt: 'desc' },
    })
    if (!zipFile) throw new NotFoundException('当前项目没有 KiCad ZIP，请先上传工程文件')
    const zip = await this.storage.get(zipFile.objectKey)
    if (!zip) throw new NotFoundException('KiCad ZIP 在对象存储中不存在')

    const dir = await mkdtemp(join(tmpdir(), 'bdc-assembly-'))
    try {
      const unzipped = await safeUnzip(zip, dir)
      const pro = unzipped.files.find((f) => f.endsWith('.kicad_pro'))
      const pcb = pickRoot(unzipped.files, '.kicad_pcb', pro)
      if (!pcb) throw new NotFoundException('KiCad ZIP 中没有找到 .kicad_pcb')
      return { filename: basename(pcb), text: await readFile(join(dir, pcb), 'utf8') }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
