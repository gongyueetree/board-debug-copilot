#!/usr/bin/env node
/**
 * 假的 kicad-cli，只给测试用。
 *
 * 它**不验证 KiCad**，验证的是我们自己的那条链路：命令怎么拼、产物在哪找、
 * 多页 SVG 会不会被漏掉、退出码非零时会不会崩。真实 KiCad 的行为要靠
 * `pnpm test:kicad-real` 在装了 KiCad 的机器上跑（见 docs/08）。
 *
 * 之所以要它：CI 上没有 KiCad，而「多页原理图导出的是目录不是文件」这类坑
 * 恰恰只在有 CLI 时才走到。没有它，那段代码在 CI 里一行都跑不到。
 *
 * 用 FAKE_KICAD_MODE 控制行为：
 *   ok       全部成功，原理图导出两页
 *   warn     ERC/DRC 以非零退出（有告警），其余成功
 *   no-sch   sch 相关子命令一律失败，模拟只有 PCB 的工程
 *   pcb-dir  PCB 也导出成目录（部分版本按层导出），验证两种形态都能收上来
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const MODE = process.env.FAKE_KICAD_MODE ?? 'ok'

if (argv[0] === '--version') {
  process.stdout.write('9.0.1-fake\n')
  process.exit(0)
}

/** --output 的值 */
function outputArg() {
  const i = argv.indexOf('--output')
  return i >= 0 ? argv[i + 1] : null
}

function write(rel, content) {
  const abs = join(process.cwd(), rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const NETLIST = `(export (version "E")
 (components
  (comp (ref "U1") (value "AD8605") (footprint "Package_SO:SOIC-8"))
  (comp (ref "R1") (value "10k") (footprint "R_0603"))
  (comp (ref "R2") (value "100k") (footprint "R_0603"))
  (comp (ref "C1") (value "100nF") (footprint "C_0603"))
  (comp (ref "J1") (value "CONN") (footprint "Connector:SMA")))
 (nets
  (net (code 1) (name "GND")
    (node (ref "U1") (pin "4") (pinfunction "V-") (pintype "power_in"))
    (node (ref "C1") (pin "2") (pintype "passive")))
  (net (code 2) (name "+5V")
    (node (ref "U1") (pin "7") (pinfunction "V+") (pintype "power_in"))
    (node (ref "C1") (pin "1") (pintype "passive")))
  (net (code 3) (name "VIN")
    (node (ref "J1") (pin "1") (pintype "passive"))
    (node (ref "R1") (pin "1") (pintype "passive")))
  (net (code 4) (name "VOUT")
    (node (ref "U1") (pin "1") (pinfunction "OUT") (pintype "output"))
    (node (ref "R2") (pin "2") (pintype "passive")))
  (net (code 5) (name "Net-(R1-Pad2)")
    (node (ref "R1") (pin "2") (pintype "passive"))
    (node (ref "R2") (pin "1") (pintype "passive"))
    (node (ref "U1") (pin "2") (pinfunction "-") (pintype "input")))))
`

const SVG = (label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text x="4" y="24">${label}</text></svg>\n`

const ercJson = JSON.stringify({
  source: 'fake.kicad_sch',
  violations: [
    {
      type: 'pin_not_connected',
      severity: 'warning',
      description: 'Pin not connected: U1 pin 3',
      items: [{ description: 'U1 pin 3' }],
    },
  ],
})

const drcJson = JSON.stringify({
  source: 'fake.kicad_pcb',
  violations: [
    {
      type: 'clearance',
      severity: 'warning',
      description: 'Clearance violation between VOUT and GND',
      items: [{ description: 'track VOUT' }],
    },
  ],
})

const [domain, verb] = argv

if (domain === 'sch' && MODE === 'no-sch') {
  process.stderr.write('fake: 该工程没有原理图\n')
  process.exit(2)
}

if (domain === 'sch' && verb === 'erc') {
  write(outputArg() ?? 'erc.json', ercJson)
  if (MODE === 'warn') {
    process.stderr.write('fake: 1 个 ERC 告警\n')
    process.exit(3) // KiCad 有告警时会以非零退出，这不算解析失败
  }
  process.exit(0)
}

if (domain === 'sch' && verb === 'export' && argv[2] === 'netlist') {
  write(outputArg() ?? 'netlist.net', NETLIST)
  process.exit(0)
}

if (domain === 'sch' && verb === 'export' && argv[2] === 'svg') {
  // 关键点：多页原理图导出的是**目录**，不是单个文件
  const out = outputArg() ?? 'sch-svg'
  write(join(out, 'page1.svg'), SVG('sheet 1'))
  write(join(out, 'page2.svg'), SVG('sheet 2'))
  write(join(out, 'notes.txt'), 'not an svg')
  process.exit(0)
}

if (domain === 'pcb' && verb === 'drc') {
  write(outputArg() ?? 'drc.json', drcJson)
  if (MODE === 'warn') {
    process.stderr.write('fake: 1 个 DRC 告警\n')
    process.exit(3)
  }
  process.exit(0)
}

if (domain === 'pcb' && verb === 'export' && argv[2] === 'svg') {
  const out = outputArg() ?? 'pcb.svg'
  if (MODE === 'pcb-dir') {
    // 按层导出时 --output 会被当成目录
    write(join(out, 'F_Cu.svg'), SVG('front copper'))
    write(join(out, 'B_Cu.svg'), SVG('back copper'))
  } else {
    // 默认：单个文件，和原理图的目录形态不一样 —— 这个差异本身就是要验的
    write(out, SVG('board'))
  }
  process.exit(0)
}

process.stderr.write(`fake: 不认识的命令 ${argv.join(' ')}\n`)
process.exit(1)
