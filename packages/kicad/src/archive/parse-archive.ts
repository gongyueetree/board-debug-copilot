/**
 * KiCad 工程解析主流程（worker 侧执行）。
 *
 * 下载 zip → 安全解压 → 找工程文件 → 跑 kicad-cli → 产物入对象存储
 * → netlist 转 Component/Net/Pin → ERC/DRC 转 RuleViolation → 规则引擎补充
 *
 * 任何一步失败都不抛到调用方：返回 status + 完整 parseLog，
 * 项目保持可用（CLAUDE.md 硬性原则 #8）。
 */
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Finding } from '@app/contracts'
import { parseProject } from '../cli/adapter'
import { parseErcDrc } from '../parser/erc-drc'
import { parseNetlist } from '../parser/netlist'
import { runSchematicRules } from '../rules/schematic-rules'
import type { DesignGraph } from '../rules/types'
import { safeUnzip } from './safe-unzip'

/** 存储与数据库能力由调用方注入，packages/kicad 不直接依赖它们 */
export interface ArchiveDeps {
  projectId: string
  objectKey: string
  prisma: PrismaLike
  storage?: StorageLike
}

export interface StorageLike {
  get(key: string): Promise<Buffer | null>
  put(key: string, data: Buffer, mimeType: string): Promise<{ objectKey: string; checksum: string }>
}

/** 只声明用到的方法，避免 packages/kicad 依赖 @app/db 的完整类型 */
export interface PrismaLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

export interface ArchiveOutcome {
  mode: 'cli' | 'mock'
  status: 'READY' | 'ERROR'
  components: number
  nets: number
  violations: number
  artifacts: number
  designVersion: number
  log: string
}

/** 单文件产物：字段名 → ProjectFile.kind */
const SINGLE_ARTIFACTS = {
  netlistPath: { kind: 'NETLIST', mime: 'text/plain' },
  ercReportPath: { kind: 'ERC_REPORT', mime: 'application/json' },
  drcReportPath: { kind: 'DRC_REPORT', mime: 'application/json' },
} as const

/** 多文件产物：多页原理图会产出多个 SVG */
const MULTI_ARTIFACTS = {
  schematicSvgPaths: { kind: 'SCHEMATIC', mime: 'image/svg+xml' },
  pcbSvgPaths: { kind: 'PCB', mime: 'image/svg+xml' },
} as const

export async function parseKicadArchive(deps: ArchiveDeps): Promise<ArchiveOutcome> {
  const { projectId, objectKey, prisma, storage } = deps
  const log: string[] = []
  let dir: string | null = null

  const fail = (reason: string): ArchiveOutcome => ({
    mode: 'mock',
    status: 'ERROR',
    components: 0,
    nets: 0,
    violations: 0,
    artifacts: 0,
    designVersion: 0,
    log: [...log, `[ERR] ${reason}`].join('\n'),
  })

  try {
    const zip = storage ? await storage.get(objectKey) : null
    if (!zip) return fail(`对象存储读不到 ${objectKey}`)
    log.push(`[OK ] fetch: ${(zip.byteLength / 1024) | 0} KB`)

    dir = await mkdtemp(join(tmpdir(), 'bdc-kicad-'))

    let unzipped
    try {
      unzipped = await safeUnzip(zip, dir)
      log.push(
        `[OK ] unzip: ${unzipped.files.length} 个文件 / ${(unzipped.totalBytes / 1024) | 0} KB`,
      )
      for (const s of unzipped.skipped.slice(0, 10)) {
        log.push(`[WARN] 跳过 ${s.name}: ${s.reason}`)
      }
    } catch (err) {
      return fail(`解压失败: ${(err as Error).message}`)
    }

    const find = (ext: string) => unzipped.files.find((f) => f.endsWith(ext))
    const sch = find('.kicad_sch')
    const pcb = find('.kicad_pcb')
    const pro = find('.kicad_pro')
    log.push(
      `[${sch || pcb ? 'OK ' : 'ERR'}] locate: pro=${pro ? '✓' : '✗'} sch=${sch ? '✓' : '✗'} pcb=${pcb ? '✓' : '✗'}`,
    )
    if (!sch && !pcb) return fail('压缩包内未找到 .kicad_sch 或 .kicad_pcb')

    const outcome = await parseProject(dir, { pro, sch, pcb })
    log.push(outcome.log)
    if (outcome.mode === 'mock') {
      log.push('[WARN] 未找到 kicad-cli，ERC/DRC 与 SVG 导出已跳过')
    }

    // 新版本号取自 Project 自身。不能从「最近一个 ProjectFile 的 parseLog」推：
    // 上传记录是在解析之前创建的，那条最近记录就是本次自己，永远读不到上一版。
    const current = await prisma.project.findUnique({
      where: { id: projectId },
      select: { designVersion: true },
    })
    const designVersion = (current?.designVersion ?? 0) + 1

    // 产物入对象存储
    let artifacts = 0
    if (storage) {
      const saveArtifact = async (rel: string, kind: string, mime: string) => {
        try {
          const buf = await readFile(join(dir!, rel))
          const key = `projects/${projectId}/kicad/v${designVersion}/${basename(rel)}`
          await storage.put(key, buf, mime)
          await prisma.projectFile.create({
            data: {
              projectId,
              kind,
              // 用实际文件名，不是 --output 传进去的那个参数
              filename: basename(rel),
              objectKey: key,
              mimeType: mime,
              sizeBytes: buf.byteLength,
              parseStatus: 'OK',
              parseLog: `designVersion=${designVersion}`,
            },
          })
          artifacts++
        } catch (err) {
          log.push(`[WARN] 产物 ${rel} 保存失败: ${(err as Error).message.slice(0, 120)}`)
        }
      }

      for (const [field, meta] of Object.entries(SINGLE_ARTIFACTS)) {
        const rel = outcome.artifacts[field as keyof typeof SINGLE_ARTIFACTS]
        if (rel) await saveArtifact(rel, meta.kind, meta.mime)
      }
      for (const [field, meta] of Object.entries(MULTI_ARTIFACTS)) {
        for (const rel of outcome.artifacts[field as keyof typeof MULTI_ARTIFACTS] ?? []) {
          await saveArtifact(rel, meta.kind, meta.mime)
        }
      }
      log.push(`[OK ] artifacts: ${artifacts} 个产物已入库`)
    }

    // netlist → 设计图
    let graph: DesignGraph | null = null
    const netRel = outcome.artifacts.netlistPath ?? unzipped.files.find((f) => f.endsWith('.net'))
    if (netRel) {
      try {
        graph = parseNetlist(await readFile(join(dir, netRel), 'utf8'))
        log.push(`[OK ] netlist: ${graph.components.length} 组件 / ${graph.nets.length} 网络`)
      } catch (err) {
        log.push(`[ERR] netlist: ${(err as Error).message.slice(0, 200)}`)
      }
    } else {
      log.push('[ERR] netlist: 未找到，无法提取结构化数据')
    }

    // ERC/DRC → RuleViolation
    const parsedFindings: Finding[] = []
    for (const [field, origin] of [
      ['ercReportPath', 'ERC'],
      ['drcReportPath', 'DRC'],
    ] as const) {
      const rel = outcome.artifacts[field]
      if (!rel) continue
      try {
        const found = parseErcDrc(await readFile(join(dir, rel), 'utf8'), origin)
        parsedFindings.push(...found)
        log.push(`[OK ] ${origin.toLowerCase()}: ${found.length} 条`)
      } catch (err) {
        log.push(`[WARN] ${origin} 解析失败: ${(err as Error).message.slice(0, 120)}`)
      }
    }

    if (!graph || graph.components.length === 0) {
      log.push('[WARN] 降级：保留项目现有设计数据，仅记录本次上传')
      log.push(`designVersion=${designVersion}`)
      return {
        mode: outcome.mode,
        status: 'READY',
        components: 0,
        nets: 0,
        violations: 0,
        artifacts,
        designVersion,
        log: log.join('\n'),
      }
    }

    const ruleFindings = runSchematicRules(graph)
    log.push(`[OK ] rules: 规则引擎 ${ruleFindings.length} 条`)

    await replaceDesign(prisma, projectId, graph, [...parsedFindings, ...ruleFindings], designVersion)
    log.push(`[OK ] persist: 设计数据已替换为 v${designVersion}`)
    log.push(`designVersion=${designVersion}`)

    return {
      mode: outcome.mode,
      status: 'READY',
      components: graph.components.length,
      nets: graph.nets.length,
      violations: parsedFindings.length + ruleFindings.length,
      artifacts,
      designVersion,
      log: log.join('\n'),
    }
  } catch (err) {
    return fail(`解析过程异常: ${(err as Error).message.slice(0, 300)}`)
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 替换设计数据。
 *
 * 照片、捕获、调试步骤、报告一律保留 —— 它们是调试过程的记录，
 * 换个设计版本不代表这些工作没发生过。但旧捕获要标记来自哪一版设计，
 * 否则 UI 会把 v1 的测量和 v2 的期望值混在一起比较。
 */
async function replaceDesign(
  prisma: PrismaLike,
  projectId: string,
  graph: DesignGraph,
  findings: Finding[],
  designVersion: number,
) {
  await prisma.$transaction(async (tx: PrismaLike) => {
    // 描述旧设计的违规全部失效，包括 ERC/DRC —— 它们引用的位号可能已不存在
    await tx.ruleViolation.deleteMany({ where: { projectId } })
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
          rawJson: { ...c.meta, designVersion },
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

    if (findings.length > 0) {
      await tx.ruleViolation.createMany({
        data: findings.map((f) => ({
          projectId,
          origin: f.origin,
          code: f.code,
          severity: f.severity,
          title: f.title,
          description: f.description,
          evidence: f.evidence.join('\n'),
          risk: f.risk,
          suggestion: f.suggestion,
          recommendedTest: f.recommendedTest ?? null,
          componentRef: f.componentRef ?? null,
          netName: f.netName ?? null,
          resolved: false,
        })),
      })
    }

    // 当前设计版本记在 Project 上。捕获在保存时把当时的版本写进
    // hardwareSetupJson，两者不一致时 UI 提示「来自旧设计版本」——
    // 比批量回写每条历史捕获更简单，也不会篡改已有记录。
    await tx.project.update({ where: { id: projectId }, data: { designVersion } })
  })
}
