/**
 * kicad-cli adapter。
 *
 * CLAUDE.md 硬性原则 #8：CLI 失败写 parseLog，不能让整个项目崩溃。
 * 所以每一步都被单独捕获，失败降级到 mock 而不是抛出。
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'

/** 产物路径统一用 posix 分隔符，后续 join(dir, rel) 在两种平台都成立 */
const joinRel = (a: string, b: string) => posix.join(a, b)

const run = promisify(execFile)

export interface ParseStep {
  name: string
  ok: boolean
  detail: string
}

export interface ParseOutcome {
  mode: 'cli' | 'mock'
  ok: boolean
  steps: ParseStep[]
  /** 写入 ProjectFile.parseLog */
  log: string
  artifacts: {
    netlistPath?: string
    /**
     * SVG 用数组：`sch export svg --output <dir>` 的输出可能是目录，
     * 多页原理图会产出多个文件。把 --output 的参数当成文件路径去 readFile
     * 会在目录上直接报错。
     */
    schematicSvgPaths: string[]
    pcbSvgPaths: string[]
    ercReportPath?: string
    drcReportPath?: string
  }
}

export interface KicadCliOptions {
  /** kicad-cli 可执行文件路径，默认从 PATH 找 */
  bin?: string
  timeoutMs?: number
}

/**
 * 扫描 `--output` 指向的位置，收集实际产出的 SVG，返回相对 dir 的 posix 路径。
 *
 * kicad-cli 对单页原理图可能直接写一个文件，多页则写进目录，版本之间行为也不一致
 * —— 所以按结果扫描，不假设 `--output` 参数就是文件路径。路径不存在时返回空数组：
 * SVG 缺失不该让整个解析失败（CLAUDE.md 硬性原则 #8）。
 */
export async function collectSvgArtifacts(dir: string, target: string): Promise<string[]> {
  const abs = join(dir, target)
  try {
    const st = await stat(abs)
    if (st.isFile()) return target.toLowerCase().endsWith('.svg') ? [target] : []
    const names = await readdir(abs)
    return names
      .filter((n) => n.toLowerCase().endsWith('.svg'))
      .sort()
      .map((n) => joinRel(target, n))
  } catch {
    return []
  }
}

export async function probeKicadCli(opts: KicadCliOptions = {}): Promise<string | null> {
  const bin = opts.bin ?? process.env.KICAD_CLI ?? 'kicad-cli'
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: opts.timeoutMs ?? 5000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * 对解压后的工程目录跑一遍 kicad-cli。
 * 找不到 CLI、缺文件、单步失败都不抛异常 —— 返回 mode='mock' 让上游用 seed 数据继续。
 */
export async function parseProject(
  dir: string,
  files: { pro?: string; sch?: string; pcb?: string },
  opts: KicadCliOptions = {},
): Promise<ParseOutcome> {
  const bin = opts.bin ?? process.env.KICAD_CLI ?? 'kicad-cli'
  const timeout = opts.timeoutMs ?? 120_000
  const steps: ParseStep[] = []
  const artifacts: ParseOutcome['artifacts'] = { schematicSvgPaths: [], pcbSvgPaths: [] }

  const version = await probeKicadCli(opts)
  if (!version) {
    steps.push({
      name: 'probe',
      ok: false,
      detail: `未找到 kicad-cli（尝试 ${bin}），降级为 mock 解析`,
    })
    return { mode: 'mock', ok: true, steps, log: renderLog(steps), artifacts }
  }
  steps.push({ name: 'probe', ok: true, detail: version })

  if (!files.sch && !files.pcb) {
    steps.push({ name: 'discover', ok: false, detail: '未找到 .kicad_sch 或 .kicad_pcb' })
    return { mode: 'mock', ok: true, steps, log: renderLog(steps), artifacts }
  }

  const attempt = async (
    name: string,
    args: string[],
    out?: 'netlistPath' | 'ercReportPath' | 'drcReportPath',
  ) => {
    try {
      const { stdout, stderr } = await run(bin, args, { cwd: dir, timeout })
      steps.push({ name, ok: true, detail: (stdout || stderr).slice(0, 400) || 'ok' })
      // 只有确定是单文件的产物才直接记路径；SVG 走 collectSvgs 扫描
      if (out) artifacts[out] = args.at(-2)
    } catch (err) {
      // ERC/DRC 产生告警会以非零退出，这不算解析失败（docs/00 §11.3）
      const soft = name === 'erc' || name === 'drc'
      steps.push({
        name,
        ok: soft,
        detail: `${soft ? '有告警但继续' : '失败'}：${(err as Error).message.slice(0, 400)}`,
      })
    }
  }

  const collectSvgs = (target: string) => collectSvgArtifacts(dir, target)

  if (files.sch) {
    // ERC/DRC 优先输出 JSON：字段稳定，好归一化成受控 code
    await attempt(
      'erc',
      ['sch', 'erc', '--format', 'json', '--output', 'erc.json', files.sch],
      'ercReportPath',
    )
    await attempt(
      'netlist',
      ['sch', 'export', 'netlist', '--output', 'netlist.net', files.sch],
      'netlistPath',
    )
    await attempt('sch-svg', ['sch', 'export', 'svg', '--output', 'sch-svg', files.sch])
    artifacts.schematicSvgPaths = await collectSvgs('sch-svg')
    steps.push({
      name: 'sch-svg-collect',
      ok: true,
      detail: `收集到 ${artifacts.schematicSvgPaths.length} 个原理图 SVG`,
    })
  }
  if (files.pcb) {
    await attempt(
      'drc',
      ['pcb', 'drc', '--format', 'json', '--output', 'drc.json', files.pcb],
      'drcReportPath',
    )
    await attempt('pcb-svg', ['pcb', 'export', 'svg', '--output', 'pcb-svg', files.pcb])
    artifacts.pcbSvgPaths = await collectSvgs('pcb-svg')
    steps.push({
      name: 'pcb-svg-collect',
      ok: true,
      detail: `收集到 ${artifacts.pcbSvgPaths.length} 个 PCB SVG`,
    })
  }

  // 只要 netlist 出来了就算成功，SVG 缺了不影响结构化数据
  const ok = steps.some((s) => s.name === 'netlist' && s.ok)
  return { mode: ok ? 'cli' : 'mock', ok: true, steps, log: renderLog(steps), artifacts }
}

function renderLog(steps: ParseStep[]): string {
  return steps.map((s) => `[${s.ok ? 'OK ' : 'ERR'}] ${s.name}: ${s.detail}`).join('\n')
}
