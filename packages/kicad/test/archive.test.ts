/**
 * parseKicadArchive 全链路：zip → 解压 → kicad-cli → 产物 → 结构化数据。
 *
 * 用 scripts/fixtures/fake-kicad-cli.mjs 顶替 kicad-cli。**这不验证 KiCad**，
 * 验证的是我们这一侧：命令怎么拼、产物去哪找、多页 SVG 会不会漏、
 * CLI 非零退出时会不会把整个项目搞挂。真实 KiCad 的行为要靠
 * `pnpm test:kicad-real`（见 docs/08）。
 *
 * 没有这层，带 CLI 的分支在 CI 里一行都跑不到 —— 而多页 SVG 那个 bug
 * 恰恰只在有 CLI 时才会走到。
 */
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseKicadArchive, pickRoot } from '../src'
import { buildZip } from '../../../scripts/lib/mini-zip'

const FAKE_CLI = join(__dirname, '../../../scripts/fixtures/fake-kicad-cli.mjs')

const PRO = '{"board":{},"meta":{"version":1}}'
const SCH = '(kicad_sch (version 20240101) (generator eeschema))'
const PCB = '(kicad_pcb (version 20240101) (generator pcbnew))'

function memoryStorage() {
  const objects = new Map<string, Buffer>()
  return {
    objects,
    async get(key: string) {
      return objects.get(key) ?? null
    },
    async put(key: string, data: Buffer) {
      objects.set(key, data)
      return { objectKey: key, checksum: 'x' }
    },
  }
}

function memoryPrisma() {
  const state = {
    projectFiles: [] as Record<string, unknown>[],
    components: [] as Record<string, unknown>[],
    nets: [] as Record<string, unknown>[],
    pins: [] as Record<string, unknown>[],
    violations: [] as Record<string, unknown>[],
    designVersion: 0,
  }
  let seq = 0
  const table = (bucket: Record<string, unknown>[]) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `id-${++seq}`, ...data }
      bucket.push(row)
      return row
    },
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      bucket.push(...data)
      return { count: data.length }
    },
    deleteMany: async () => {
      bucket.length = 0
      return { count: 0 }
    },
  })
  const db = {
    state,
    project: {
      findUnique: async () => ({ designVersion: state.designVersion }),
      update: async ({ data }: { data: { designVersion?: number } }) => {
        if (data.designVersion) state.designVersion = data.designVersion
        return {}
      },
    },
    projectFile: table(state.projectFiles),
    component: table(state.components),
    net: table(state.nets),
    pin: table(state.pins),
    ruleViolation: table(state.violations),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  }
  return db
}

async function run(
  files: { name: string; data: Buffer }[],
  env: { cli?: string; mode?: string } = {},
) {
  const storage = memoryStorage()
  const prisma = memoryPrisma()
  const key = 'projects/p1/kicad/upload.zip'
  storage.objects.set(key, buildZip(files))

  const prevCli = process.env.KICAD_CLI
  const prevMode = process.env.FAKE_KICAD_MODE
  if (env.cli !== undefined) process.env.KICAD_CLI = env.cli
  if (env.mode !== undefined) process.env.FAKE_KICAD_MODE = env.mode
  try {
    const outcome = await parseKicadArchive({
      projectId: 'p1',
      objectKey: key,
      prisma: prisma as never,
      storage,
    })
    return { outcome, state: prisma.state, objects: storage.objects }
  } finally {
    if (prevCli === undefined) delete process.env.KICAD_CLI
    else process.env.KICAD_CLI = prevCli
    if (prevMode === undefined) delete process.env.FAKE_KICAD_MODE
    else process.env.FAKE_KICAD_MODE = prevMode
  }
}

const f = (name: string, content: string) => ({ name, data: Buffer.from(content, 'utf8') })
const fullProject = () => [
  f('demo/demo.kicad_pro', PRO),
  f('demo/demo.kicad_sch', SCH),
  f('demo/demo.kicad_pcb', PCB),
]

const kinds = (state: { projectFiles: Record<string, unknown>[] }) =>
  state.projectFiles.map((p) => p.kind as string)

beforeAll(() => {
  chmodSync(FAKE_CLI, 0o755)
})

describe('parseKicadArchive · 无 kicad-cli', () => {
  it('降级为 mock 模式而不是失败', async () => {
    const { outcome } = await run(fullProject(), { cli: '/nonexistent/kicad-cli' })
    expect(outcome.mode).toBe('mock')
    expect(outcome.status).toBe('READY')
    expect(outcome.log).toContain('未找到 kicad-cli')
  })

  it('三种工程文件仍然被识别出来', async () => {
    const { outcome } = await run(fullProject(), { cli: '/nonexistent/kicad-cli' })
    expect(outcome.log).toContain('locate: pro=✓ sch=✓ pcb=✓')
  })

  it('压缩包里没有工程文件时报错但不抛异常', async () => {
    const { outcome } = await run([f('readme.txt', 'nothing here')], {
      cli: '/nonexistent/kicad-cli',
    })
    expect(outcome.status).toBe('ERROR')
    expect(outcome.log).toContain('未找到 .kicad_sch 或 .kicad_pcb')
  })
})

describe('parseKicadArchive · 有 kicad-cli', () => {
  it('走 cli 模式并解析出组件与网络', async () => {
    const { outcome } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    expect(outcome.mode).toBe('cli')
    expect(outcome.status).toBe('READY')
    expect(outcome.components).toBe(5)
    expect(outcome.nets).toBe(5)
  })

  it('Component / Net / Pin 都落库，Pin 挂到对应的网络上', async () => {
    const { state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    expect(state.components).toHaveLength(5)
    expect(state.nets).toHaveLength(5)
    expect(state.pins.length).toBeGreaterThanOrEqual(11)
    // 至少一部分 pin 连上了网络，否则说明 netId 映射断了
    expect(state.pins.filter((p) => p.netId).length).toBeGreaterThan(8)
  })

  it('多页原理图保存多个 SVG，且用实际文件名', async () => {
    // 早先把 --output 的参数当文件路径直接读，遇到目录整条解析会挂
    const { state, outcome } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    const sch = state.projectFiles.filter((p) => p.kind === 'SCHEMATIC')
    expect(sch).toHaveLength(2)
    expect(sch.map((p) => p.filename).sort()).toEqual(['page1.svg', 'page2.svg'])
    // netlist + erc + drc + 2 张原理图 + 1 张 PCB = 6。
    // 目录里的 notes.txt 不是 SVG，被算进去就会变成 7。
    expect(outcome.artifacts).toBe(6)
  })

  it('PCB 的单文件输出同样被识别', async () => {
    const { state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    const pcb = state.projectFiles.filter((p) => p.kind === 'PCB')
    expect(pcb).toHaveLength(1)
    expect(pcb[0]?.filename).toBe('pcb.svg')
  })

  it('PCB 按层导出成目录时，每一层各自入库', async () => {
    const { state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'pcb-dir' })
    const pcb = state.projectFiles.filter((p) => p.kind === 'PCB')
    expect(pcb.map((p) => p.filename).sort()).toEqual(['B_Cu.svg', 'F_Cu.svg'])
  })

  it('netlist / ERC / DRC 三个产物都入库', async () => {
    const { state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    expect(kinds(state)).toEqual(
      expect.arrayContaining(['NETLIST', 'ERC_REPORT', 'DRC_REPORT']),
    )
  })

  it('ERC/DRC 的违规转成 RuleViolation', async () => {
    const { outcome, state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    const origins = state.violations.map((v) => v.origin as string)
    expect(origins).toEqual(expect.arrayContaining(['ERC', 'DRC']))
    expect(outcome.violations).toBeGreaterThanOrEqual(2)
  })

  it('产物 key 带 designVersion，重复上传不会互相覆盖', async () => {
    const { objects } = await run(fullProject(), { cli: FAKE_CLI, mode: 'ok' })
    const artifactKeys = [...objects.keys()].filter((k) => k.includes('/kicad/v'))
    expect(artifactKeys.length).toBeGreaterThan(0)
    expect(artifactKeys.every((k) => /\/kicad\/v\d+\//.test(k))).toBe(true)
  })

  it('ERC/DRC 有告警（非零退出）不算解析失败', async () => {
    const { outcome } = await run(fullProject(), { cli: FAKE_CLI, mode: 'warn' })
    expect(outcome.status).toBe('READY')
    expect(outcome.components).toBe(5)
    expect(outcome.log).toContain('有告警但继续')
  })

  it('原理图相关命令全失败时降级，不清空设计数据', async () => {
    // 只有 PCB 的工程：没有 netlist 很正常，不该被当成解析失败
    const { outcome, state } = await run(fullProject(), { cli: FAKE_CLI, mode: 'no-sch' })
    expect(outcome.status).toBe('READY')
    expect(outcome.components).toBe(0)
    expect(outcome.log).toContain('降级')
    expect(state.components).toHaveLength(0)
    // PCB 侧的产物仍然拿到了
    expect(kinds(state)).toEqual(expect.arrayContaining(['DRC_REPORT', 'PCB']))
  })

  it('parseLog 是可读的分步格式，失败时能定位到哪一步', async () => {
    const { outcome } = await run(fullProject(), { cli: FAKE_CLI, mode: 'no-sch' })
    for (const step of ['fetch', 'unzip', 'locate', 'probe']) {
      expect(outcome.log).toContain(step)
    }
    expect(outcome.log).toMatch(/\[(OK |ERR|WARN)\]/)
  })
})

describe('pickRoot', () => {
  // 真实的层次化工程有多个 .kicad_sch。随手 find() 到子图不会报错，
  // 只是安静地少一半器件、少几页 SVG —— 这个 bug 是 multi-sheet fixture
  // 在真 KiCad 上跑出来的。
  it('多个 sch 时按 .kicad_pro 同名挑根图', () => {
    const files = ['p/amp.kicad_sch', 'p/psu.kicad_sch', 'p/board.kicad_sch', 'p/board.kicad_pro']
    expect(pickRoot(files, '.kicad_sch', 'p/board.kicad_pro')).toBe('p/board.kicad_sch')
  })

  it('只有一个候选时直接返回，不做多余判断', () => {
    expect(pickRoot(['p/only.kicad_sch'], '.kicad_sch', undefined)).toBe('p/only.kicad_sch')
  })

  it('没有候选返回 undefined', () => {
    expect(pickRoot(['p/board.kicad_pcb'], '.kicad_sch', undefined)).toBeUndefined()
  })

  it('没有 pro 时退回层级最浅的', () => {
    const files = ['sub/deep/child.kicad_sch', 'root.kicad_sch', 'sub/other.kicad_sch']
    expect(pickRoot(files, '.kicad_sch', undefined)).toBe('root.kicad_sch')
  })

  it('同层级时取名字最短的，结果稳定', () => {
    const files = ['a/aaa-sub.kicad_sch', 'a/top.kicad_sch']
    expect(pickRoot(files, '.kicad_sch', undefined)).toBe('a/top.kicad_sch')
  })

  it('pro 名字对不上任何 sch 时不硬凑，退回层级规则', () => {
    const files = ['p/amp.kicad_sch', 'p/psu.kicad_sch']
    expect(pickRoot(files, '.kicad_sch', 'p/unrelated.kicad_pro')).toBe('p/amp.kicad_sch')
  })

  it('pcb 走同一套规则', () => {
    const files = ['p/panel.kicad_pcb', 'p/board.kicad_pcb', 'p/board.kicad_pro']
    expect(pickRoot(files, '.kicad_pcb', 'p/board.kicad_pro')).toBe('p/board.kicad_pcb')
  })
})
