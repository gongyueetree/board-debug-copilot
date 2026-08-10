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
  /**
   * DRC 单独的超时。
   *
   * KiCad 10.0.1 的 `pcb drc` 在 macOS 上会无限挂住（空板也挂，见 docs/08 §6），
   * 用统一的 120s 会让每次带 PCB 的解析白等两分钟。DRC 失败不影响 netlist，
   * 所以宁可早点放弃。真实大板的 DRC 可能确实要更久，用
   * KICAD_DRC_TIMEOUT_MS 调。
   */
  drcTimeoutMs?: number
}

/** `pcb export svg` 必须指定层，否则直接报错退出（KiCad 9 起） */
const DEFAULT_PCB_SVG_LAYERS = 'F.Cu,B.Cu,F.SilkS,F.Mask,Edge.Cuts'

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

  const envDrcTimeout = Number(process.env.KICAD_DRC_TIMEOUT_MS)
  const drcTimeout =
    opts.drcTimeoutMs ?? (Number.isFinite(envDrcTimeout) && envDrcTimeout > 0 ? envDrcTimeout : 60_000)

  const attempt = async (
    name: string,
    args: string[],
    out?: 'netlistPath' | 'ercReportPath' | 'drcReportPath',
  ) => {
    const budget = name === 'drc' ? drcTimeout : timeout
    try {
      const { stdout, stderr } = await run(bin, args, { cwd: dir, timeout: budget })
      steps.push({ name, ok: true, detail: (stdout || stderr).slice(0, 400) || 'ok' })
      // 只有确定是单文件的产物才直接记路径；SVG 走 collectSvgs 扫描
      if (out) artifacts[out] = args.at(-2)
    } catch (err) {
      // ERC/DRC 产生告警会以非零退出，这不算解析失败（docs/00 §11.3）
      const soft = name === 'erc' || name === 'drc'
      const e = err as Error & { killed?: boolean; signal?: string }
      // 超时和「有告警」长得完全不一样，日志里必须能区分，
      // 否则 KiCad 那个挂死会被读成「板子有问题」
      const timedOut = e.killed === true || e.signal === 'SIGTERM'
      const detail = timedOut
        ? `超时 ${budget}ms 被终止` +
          (name === 'drc' ? '（KiCad 10 的 pcb drc 有挂死问题，见 docs/08 §6）' : '')
        : `${soft ? '有告警但继续' : '失败'}：${e.message.slice(0, 400)}`
      steps.push({ name, ok: soft, detail })
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
    // --layers 是必须的：不给的话 KiCad 9/10 直接以
    // 「At least one layer must be specified」退出，一张 SVG 都不产。
    // --output 在单层模式下是文件名，--mode-multi 下是目录 —— collectSvgs 两种都认。
    await attempt('pcb-svg', [
      'pcb',
      'export',
      'svg',
      '--layers',
      process.env.KICAD_PCB_SVG_LAYERS || DEFAULT_PCB_SVG_LAYERS,
      '--output',
      'pcb.svg',
      files.pcb,
    ])
    artifacts.pcbSvgPaths = await collectSvgs('pcb.svg')
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
