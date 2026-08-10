/**
 * 真实 KiCad 工程解析验证。
 *
 *   pnpm test:kicad-real
 *
 * 没装 kicad-cli 就整体 SKIPPED 并退 0 —— CI 默认没有 KiCad，这条链路只能在
 * 装了 KiCad 的机器上验，不该因此把 CI 变红。
 *
 * 装了 kicad-cli 时，对 examples/kicad-fixtures 下每个 fixture：
 *   打包 project/ → parseKicadArchive（和线上上传完全同一条路径）→ 按
 *   manifest.json 的 expect 断言。
 *
 * 存储与数据库都用内存替身：这里验的是解析链路，不是持久化。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseKicadArchive, probeKicadCli } from '@app/kicad'
import { buildZip, type ZipEntry } from './lib/mini-zip'

const ROOT = join(__dirname, '..', 'examples', 'kicad-fixtures')

interface Expect {
  hasPro?: boolean
  hasSch?: boolean
  hasPcb?: boolean
  netlist?: boolean
  erc?: boolean
  drc?: boolean
  minComponents?: number
  minNets?: number
  minSchematicSvgs?: number
  minPcbSvgs?: number
  mustNotCrash?: boolean
  parseLogMentions?: string[]
}

interface Manifest {
  status: 'placeholder' | 'ready'
  kicadVersion?: string
  description?: string
  expect: Expect
}

// ------------------------------------------------------------- 内存替身

/** 只实现 parseKicadArchive 用到的那几个方法 */
function memoryStorage() {
  const objects = new Map<string, { data: Buffer; mimeType: string }>()
  return {
    objects,
    async get(key: string) {
      return objects.get(key)?.data ?? null
    },
    async put(key: string, data: Buffer, mimeType: string) {
      objects.set(key, { data, mimeType })
      return { objectKey: key, checksum: 'x' }
    },
  }
}

/**
 * 内存 prisma。
 *
 * parseKicadArchive 走 $transaction + create/deleteMany/createMany，
 * 这里按最小语义实现，够断言组件/网络/违规数量即可。
 */
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
  const id = () => `id-${++seq}`

  const table = (bucket: Record<string, unknown>[]) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: id(), ...data }
      bucket.push(row)
      return row
    },
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      for (const d of data) bucket.push({ id: id(), ...d })
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

// ------------------------------------------------------------- fixture

async function collectFiles(dir: string, base = dir): Promise<ZipEntry[]> {
  const out: ZipEntry[] = []
  for (const name of await readdir(dir)) {
    // .gitkeep 只是占位，别打进 zip 里干扰文件识别
    if (name === '.gitkeep' || name === '.DS_Store') continue
    const abs = join(dir, name)
    const st = await stat(abs)
    if (st.isDirectory()) {
      out.push(...(await collectFiles(abs, base)))
    } else {
      out.push({ name: relative(base, abs).split('\\').join('/'), data: await readFile(abs) })
    }
  }
  return out
}

interface Result {
  fixture: string
  state: 'pass' | 'fail' | 'placeholder'
  detail: string
  failures: string[]
}

async function runFixture(name: string): Promise<Result> {
  const dir = join(ROOT, name)
  const manifest: Manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const files = await collectFiles(join(dir, 'project'))

  if (files.length === 0) {
    return {
      fixture: name,
      state: 'placeholder',
      detail:
        manifest.status === 'ready'
          ? 'manifest 写着 ready，但 project/ 是空的'
          : `占位：${manifest.description ?? ''}`,
      failures:
        manifest.status === 'ready'
          ? ['manifest.status=ready 但没有工程文件，二者必须一致']
          : [],
    }
  }

  const storage = memoryStorage()
  const prisma = memoryPrisma()
  const projectId = `fixture-${name}`
  const objectKey = `projects/${projectId}/kicad/${name}.zip`
  storage.objects.set(objectKey, {
    data: buildZip(files),
    mimeType: 'application/zip',
  })

  let outcome
  try {
    outcome = await parseKicadArchive({
      projectId,
      objectKey,
      prisma: prisma as never,
      storage,
    })
  } catch (err) {
    // 硬性原则 #8：解析失败要写 parseLog，不该抛到调用方
    return {
      fixture: name,
      state: 'fail',
      detail: '抛出异常',
      failures: [`parseKicadArchive 抛异常而不是返回 parseLog：${(err as Error).message}`],
    }
  }

  const e = manifest.expect
  const fail: string[] = []
  const log = outcome.log
  const kinds = prisma.state.projectFiles.map((f) => f.kind as string)
  const schSvgs = kinds.filter((k) => k === 'SCHEMATIC').length
  const pcbSvgs = kinds.filter((k) => k === 'PCB').length

  const locate = /locate: pro=(.) sch=(.) pcb=(.)/.exec(log)
  const found = { pro: locate?.[1] === '✓', sch: locate?.[2] === '✓', pcb: locate?.[3] === '✓' }

  const check = (cond: boolean, msg: string) => {
    if (!cond) fail.push(msg)
  }

  if (e.hasPro !== undefined) check(found.pro === e.hasPro, `.kicad_pro 识别应为 ${e.hasPro}`)
  if (e.hasSch !== undefined) check(found.sch === e.hasSch, `.kicad_sch 识别应为 ${e.hasSch}`)
  if (e.hasPcb !== undefined) check(found.pcb === e.hasPcb, `.kicad_pcb 识别应为 ${e.hasPcb}`)

  if (e.netlist !== undefined) {
    check(kinds.includes('NETLIST') === e.netlist, `netlist 产物应为 ${e.netlist}`)
  }
  if (e.erc !== undefined) check(kinds.includes('ERC_REPORT') === e.erc, `ERC 报告应为 ${e.erc}`)
  if (e.drc !== undefined) check(kinds.includes('DRC_REPORT') === e.drc, `DRC 报告应为 ${e.drc}`)

  if (e.minComponents !== undefined) {
    check(
      outcome.components >= e.minComponents,
      `组件数 ${outcome.components} < ${e.minComponents}`,
    )
  }
  if (e.minNets !== undefined) {
    check(outcome.nets >= e.minNets, `网络数 ${outcome.nets} < ${e.minNets}`)
  }
  if (e.minSchematicSvgs !== undefined) {
    check(schSvgs >= e.minSchematicSvgs, `原理图 SVG ${schSvgs} < ${e.minSchematicSvgs}`)
  }
  if (e.minPcbSvgs !== undefined) {
    check(pcbSvgs >= e.minPcbSvgs, `PCB SVG ${pcbSvgs} < ${e.minPcbSvgs}`)
  }
  if (e.mustNotCrash) {
    // parseLog 是失败时唯一的线索，空日志等于没有线索
    check(log.trim().length > 0, 'parseLog 为空')
    check(/\[(OK |ERR|WARN)\]/.test(log), 'parseLog 不是可读的分步格式')
  }
  for (const needle of e.parseLogMentions ?? []) {
    check(log.toLowerCase().includes(needle.toLowerCase()), `parseLog 未提到「${needle}」`)
  }

  return {
    fixture: name,
    state: fail.length === 0 ? 'pass' : 'fail',
    detail:
      `mode=${outcome.mode} ${outcome.components} 组件 / ${outcome.nets} 网络 / ` +
      `${outcome.violations} 违规 / 产物 ${outcome.artifacts}（sch-svg ${schSvgs}, pcb-svg ${pcbSvgs}）`,
    failures: fail,
  }
}

async function main() {
  const version = await probeKicadCli()
  console.log('真实 KiCad 工程解析验证')

  if (!version) {
    console.log(`  SKIPPED  未找到 kicad-cli（KICAD_CLI=${process.env.KICAD_CLI ?? '未设置'}）`)
    console.log('           安装方式与验证步骤见 docs/08-real-kicad-validation.md')
    process.exit(0)
  }
  console.log(`  kicad-cli: ${version}\n`)

  const names = (await readdir(ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  let failed = 0
  let passed = 0
  let placeholders = 0

  for (const name of names) {
    const r = await runFixture(name)
    // 占位本身不算失败，但「manifest 说 ready 却没文件」算 —— 那是配置说了谎
    if (r.failures.length > 0) {
      failed++
      console.log(`  ✗ ${name.padEnd(24)} ${r.detail}`)
    } else if (r.state === 'placeholder') {
      placeholders++
      // 占位必须在输出里显形，否则「0 失败」会被读成「已经验证过了」
      console.log(`  ○ ${name.padEnd(24)} PLACEHOLDER  ${r.detail}`)
    } else {
      passed++
      console.log(`  ✓ ${name.padEnd(24)} ${r.detail}`)
    }
    for (const f of r.failures) console.log(`      · ${f}`)
  }

  const ran = passed + failed
  console.log(
    `\n${passed}/${ran} 个可运行 fixture 通过` +
      (placeholders > 0
        ? `，${placeholders} 个仍是占位（见 examples/kicad-fixtures/README.md）`
        : ''),
  )
  process.exit(failed > 0 ? 1 : 0)
}

void main()
