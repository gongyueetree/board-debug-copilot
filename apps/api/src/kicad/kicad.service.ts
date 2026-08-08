import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { parseNetlist, parseProject, type DesignGraph } from '@app/kicad'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const run = promisify(execFile)

export interface ParseResult {
  projectId: string
  mode: 'cli' | 'mock'
  status: 'READY' | 'ERROR'
  components: number
  nets: number
  files: string[]
  log: string
}

/**
 * KiCad zip 解析。
 *
 * CLAUDE.md 硬性原则 #8：CLI 失败写 parseLog，不能让整个项目崩溃。
 * 因此这里没有任何一处会把异常抛到调用方 —— 最坏情况是 status=ERROR + 完整 parseLog，
 * 项目本身仍然可用（原有数据不动）。
 */
@Injectable()
export class KicadService {
  private readonly logger = new Logger(KicadService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async uploadAndParse(
    projectId: string,
    input: { filename: string; base64: string; mimeType?: string },
  ): Promise<ParseResult> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException(`项目不存在: ${projectId}`)

    const data = Buffer.from(input.base64, 'base64')
    this.storage.validate('zip', input.mimeType ?? 'application/zip', data.byteLength)

    const key = `projects/${projectId}/kicad/${Date.now()}-${input.filename}`
    const { objectKey, checksum } = await this.storage.put(key, data, 'application/zip')

    const file = await this.prisma.projectFile.create({
      data: {
        projectId,
        kind: 'KICAD_ZIP',
        filename: input.filename,
        objectKey,
        mimeType: 'application/zip',
        sizeBytes: data.byteLength,
        checksum,
        parseStatus: 'PENDING',
      },
    })

    await this.prisma.project.update({ where: { id: projectId }, data: { status: 'PARSING' } })

    const result = await this.parse(projectId, data)

    await this.prisma.projectFile.update({
      where: { id: file.id },
      data: { parseStatus: result.status, parseLog: result.log },
    })
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: result.status },
    })

    return result
  }

  /** 解压 → 找工程文件 → kicad-cli（缺失则降级）→ 解析 netlist → 入库 */
  private async parse(projectId: string, zip: Buffer): Promise<ParseResult> {
    const log: string[] = []
    let dir: string | null = null

    try {
      dir = await mkdtemp(join(tmpdir(), 'bdc-kicad-'))
      const zipPath = join(dir, 'project.zip')
      await writeFile(zipPath, zip)

      // 用系统 unzip 而不是引 JS 解压库：Nixpacks 镜像里就有，少一个依赖
      try {
        await run('unzip', ['-q', '-o', zipPath, '-d', dir], { timeout: 60_000 })
        log.push('[OK ] unzip: 解压完成')
      } catch (err) {
        log.push(`[ERR] unzip: ${(err as Error).message.slice(0, 200)}`)
        return this.fail(projectId, log, '解压失败，zip 可能损坏或不是有效压缩包')
      }

      const files = await this.walk(dir)
      const rel = files.map((f) => relative(dir!, f))
      log.push(`[OK ] discover: 共 ${rel.length} 个文件`)

      const pick = (ext: string) => files.find((f) => f.endsWith(ext))
      const sch = pick('.kicad_sch')
      const pcb = pick('.kicad_pcb')
      const pro = pick('.kicad_pro')
      log.push(
        `[${sch || pcb ? 'OK ' : 'ERR'}] locate: ` +
          `pro=${pro ? '✓' : '✗'} sch=${sch ? '✓' : '✗'} pcb=${pcb ? '✓' : '✗'}`,
      )

      if (!sch && !pcb) {
        return this.fail(projectId, log, '压缩包内未找到 .kicad_sch 或 .kicad_pcb')
      }

      const outcome = await parseProject(dir, {
        pro: pro ? relative(dir, pro) : undefined,
        sch: sch ? relative(dir, sch) : undefined,
        pcb: pcb ? relative(dir, pcb) : undefined,
      })
      log.push(outcome.log)

      // 优先用 CLI 导出的 netlist；没有就找包里自带的 .net
      let graph: DesignGraph | null = null
      const netPath = outcome.artifacts.netlistPath
        ? join(dir, outcome.artifacts.netlistPath)
        : files.find((f) => f.endsWith('.net'))

      if (netPath) {
        try {
          graph = parseNetlist(await readFile(netPath, 'utf8'))
          log.push(
            `[OK ] netlist: 解析出 ${graph.components.length} 个组件 / ${graph.nets.length} 个网络`,
          )
        } catch (err) {
          log.push(`[ERR] netlist: ${(err as Error).message.slice(0, 200)}`)
        }
      } else {
        log.push('[ERR] netlist: 未找到 netlist，无法提取结构化数据')
      }

      if (!graph || graph.components.length === 0) {
        // 解析不出结构化数据不算项目失败：保留原有 seed 数据，把原因写进 parseLog
        log.push('[WARN] 降级：保留项目现有设计数据，仅记录本次上传')
        return {
          projectId,
          mode: outcome.mode,
          status: 'READY',
          components: 0,
          nets: 0,
          files: rel,
          log: log.join('\n'),
        }
      }

      await this.replaceDesign(projectId, graph)
      log.push('[OK ] persist: 设计数据已替换')

      return {
        projectId,
        mode: outcome.mode,
        status: 'READY',
        components: graph.components.length,
        nets: graph.nets.length,
        files: rel,
        log: log.join('\n'),
      }
    } catch (err) {
      log.push(`[ERR] fatal: ${(err as Error).message.slice(0, 300)}`)
      return this.fail(projectId, log, '解析过程异常')
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private fail(projectId: string, log: string[], reason: string): ParseResult {
    this.logger.warn(`KiCad 解析失败 ${projectId}: ${reason}`)
    return {
      projectId,
      mode: 'mock',
      status: 'ERROR',
      components: 0,
      nets: 0,
      files: [],
      log: [...log, `[ERR] ${reason}`].join('\n'),
    }
  }

  /** 用解析结果整体替换设计数据。捕获、步骤、照片、报告都不动。 */
  private async replaceDesign(projectId: string, graph: DesignGraph) {
    await this.prisma.$transaction(async (tx) => {
      // 设计被整体替换后，所有描述旧设计的违规都失效 —— 包括 ERC/DRC。
      // 只删 RULE_ENGINE/AI 会留下引用已删除位号的僵尸记录，
      // 那些位号在新工程里根本不存在。
      await tx.ruleViolation.deleteMany({ where: { projectId } })
      // Pin 由 Component 级联删除，Net 上的引用会随之清空
      await tx.component.deleteMany({ where: { projectId } })
      await tx.net.deleteMany({ where: { projectId } })

      const netId = new Map<string, string>()
      for (const n of graph.nets) {
        const created = await tx.net.create({
          data: {
            projectId,
            name: n.name,
            inferredRole: n.inferredRole,
            expectedVoltage: n.expectedVoltage,
          },
        })
        netId.set(n.name, created.id)
      }

      for (const c of graph.components) {
        const created = await tx.component.create({
          data: {
            projectId,
            ref: c.ref,
            value: c.value,
            partNumber: c.partNumber,
            footprint: (c.meta.footprint as string | undefined) ?? null,
            rawJson: c.meta as never,
          },
        })
        for (const p of c.pins) {
          await tx.pin.create({
            data: {
              componentId: created.id,
              number: p.number,
              name: p.name,
              type: p.type,
              netId: p.netName ? (netId.get(p.netName) ?? null) : null,
            },
          })
        }
      }
    })
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = []
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...(await this.walk(full)))
      else out.push(full)
    }
    return out
  }
}
