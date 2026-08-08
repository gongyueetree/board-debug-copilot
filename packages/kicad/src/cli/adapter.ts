/**
 * kicad-cli adapter。
 *
 * CLAUDE.md 硬性原则 #8：CLI 失败写 parseLog，不能让整个项目崩溃。
 * 所以每一步都被单独捕获，失败降级到 mock 而不是抛出。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
    schematicSvgPath?: string
    pcbSvgPath?: string
    ercReportPath?: string
    drcReportPath?: string
  }
}

export interface KicadCliOptions {
  /** kicad-cli 可执行文件路径，默认从 PATH 找 */
  bin?: string
  timeoutMs?: number
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
  const artifacts: ParseOutcome['artifacts'] = {}

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

  const attempt = async (name: string, args: string[], out?: keyof ParseOutcome['artifacts']) => {
    try {
      const { stdout, stderr } = await run(bin, args, { cwd: dir, timeout })
      steps.push({ name, ok: true, detail: (stdout || stderr).slice(0, 400) || 'ok' })
      if (out) artifacts[out] = args.at(-1)
    } catch (err) {
      // ERC/DRC 产生警告会以非零退出，这不算解析失败（docs/00 §11.3）
      const soft = name === 'erc' || name === 'drc'
      steps.push({
        name,
        ok: soft,
        detail: `${soft ? '有告警但继续' : '失败'}：${(err as Error).message.slice(0, 400)}`,
      })
    }
  }

  if (files.sch) {
    await attempt('erc', ['sch', 'erc', '--output', 'erc.rpt', files.sch], 'ercReportPath')
    await attempt(
      'netlist',
      ['sch', 'export', 'netlist', '--output', 'netlist.net', files.sch],
      'netlistPath',
    )
    await attempt(
      'sch-svg',
      ['sch', 'export', 'svg', '--output', 'sch-svg', files.sch],
      'schematicSvgPath',
    )
  }
  if (files.pcb) {
    await attempt('drc', ['pcb', 'drc', '--output', 'drc.rpt', files.pcb], 'drcReportPath')
    await attempt(
      'pcb-svg',
      ['pcb', 'export', 'svg', '--output', 'pcb.svg', files.pcb],
      'pcbSvgPath',
    )
  }

  // 只要 netlist 出来了就算成功，SVG 缺了不影响结构化数据
  const ok = steps.some((s) => s.name === 'netlist' && s.ok)
  return { mode: ok ? 'cli' : 'mock', ok: true, steps, log: renderLog(steps), artifacts }
}

function renderLog(steps: ParseStep[]): string {
  return steps.map((s) => `[${s.ok ? 'OK ' : 'ERR'}] ${s.name}: ${s.detail}`).join('\n')
}
