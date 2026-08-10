import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkEntryPath,
  collectSvgArtifacts,
  inferCategory,
  inferNetRole,
  inferPinType,
  parseNetlist,
} from '../src'
import { DEFAULT_LIMITS } from '../src/archive/safe-unzip'
import { normalizeCode, normalizeSeverity, parseErcDrc } from '../src/parser/erc-drc'

const FIXTURE = `(export (version "E")
 (components
  (comp (ref "U1") (value "AD8605") (footprint "Package_SO:SOIC-8"))
  (comp (ref "U3") (value "TPS7A0233") (footprint "SOT-23-5"))
  (comp (ref "R1") (value "100k") (footprint "R_0603"))
  (comp (ref "C1") (value "100nF") (footprint "C_0603"))
  (comp (ref "J1") (value "CONN") (footprint "Connector:SMA")))
 (nets
  (net (code 1) (name "GND")
    (node (ref "U1") (pin "4") (pinfunction "V-") (pintype "power_in"))
    (node (ref "C1") (pin "2")))
  (net (code 2) (name "3V3")
    (node (ref "U3") (pin "5") (pinfunction "OUT") (pintype "power_out"))
    (node (ref "U1") (pin "8") (pinfunction "V+") (pintype "power_in")))
  (net (code 3) (name "SDA")
    (node (ref "U1") (pin "1")))
  (net (code 4) (name "VOUT_AMP")
    (node (ref "U1") (pin "1") (pinfunction "OUT") (pintype "output"))
    (node (ref "R1") (pin "2")))))`

describe('netlist 解析', () => {
  const g = parseNetlist(FIXTURE)

  it('解析出全部组件与网络', () => {
    expect(g.components).toHaveLength(5)
    expect(g.nets).toHaveLength(4)
  })

  it('按位号与值推断类别', () => {
    const byRef = Object.fromEntries(g.components.map((c) => [c.ref, c.category]))
    expect(byRef.U1).toBe('运算放大器')
    expect(byRef.U3).toBe('LDO 稳压器')
    expect(byRef.R1).toBe('电阻')
    expect(byRef.C1).toBe('电容')
    expect(byRef.J1).toBe('连接器')
  })

  it('按网络名推断角色', () => {
    const byName = Object.fromEntries(g.nets.map((n) => [n.name, n.inferredRole]))
    expect(byName.GND).toBe('GND')
    expect(byName['3V3']).toBe('POWER')
    expect(byName.SDA).toBe('I2C')
    expect(byName.VOUT_AMP).toBe('SIGNAL')
  })

  it('引脚带上所属网络', () => {
    const u1 = g.components.find((c) => c.ref === 'U1')!
    const vplus = u1.pins.find((p) => p.name === 'V+')
    expect(vplus?.netName).toBe('3V3')
    expect(vplus?.type).toBe('power_in')
  })

  it('空输入不抛异常', () => {
    expect(() => parseNetlist('')).not.toThrow()
    expect(parseNetlist('').components).toHaveLength(0)
  })
})

describe('类型推断', () => {
  it('缺 pintype 时按引脚名兜底', () => {
    expect(inferPinType('VDD', null)).toBe('power_in')
    expect(inferPinType('OUT', null)).toBe('output')
    expect(inferPinType('SDA', null)).toBe('bidirectional')
    expect(inferPinType('NC', null)).toBe('no_connect')
  })

  it('显式 pintype 优先于推断', () => {
    expect(inferPinType('VDD', 'output')).toBe('output')
  })

  it('unspecified 视为无声明', () => {
    expect(inferPinType('VDD', 'unspecified')).toBe('power_in')
  })

  it('未知网络名归到 SIGNAL', () => {
    expect(inferNetRole('MYSTERY_NET')).toBe('SIGNAL')
  })

  it('识别常见电源命名', () => {
    for (const n of ['VCC', 'VDD', '3V3', '5V', '1V8']) {
      expect(inferNetRole(n)).toBe('POWER')
    }
  })

  it('未知位号不崩', () => {
    expect(inferCategory('XYZ99', null, null)).toBe('其他')
  })
})

describe('ERC/DRC 报告解析', () => {
  it('解析 JSON 格式', () => {
    const raw = JSON.stringify({
      violations: [
        {
          type: 'pin_not_connected',
          description: 'Pin U1.5 not connected',
          severity: 'warning',
          items: [{ description: 'Symbol U1 Pin 5' }],
        },
      ],
    })
    const f = parseErcDrc(raw, 'ERC')
    expect(f).toHaveLength(1)
    expect(f[0]!.origin).toBe('ERC')
    expect(f[0]!.severity).toBe('WARNING')
    expect(f[0]!.componentRef).toBe('U1')
  })

  it('归一化到受控 code', () => {
    expect(normalizeCode('pin_not_connected')).toBe('FLOATING_INPUT')
    expect(normalizeCode('clearance')).toBe('GND_REFERENCE_DISCONTINUITY')
  })

  it('severity 映射', () => {
    expect(normalizeSeverity('error')).toBe('CRITICAL')
    expect(normalizeSeverity('warning')).toBe('WARNING')
    expect(normalizeSeverity(undefined)).toBe('INFO')
  })

  it('坏 JSON 返回空数组而不是抛异常', () => {
    expect(parseErcDrc('{ broken', 'ERC')).toEqual([])
  })

  it('每条 finding 的 evidence 非空', () => {
    const raw = JSON.stringify({ violations: [{ type: 'x', description: 'D' }] })
    for (const f of parseErcDrc(raw, 'DRC')) {
      expect(f.evidence.length).toBeGreaterThan(0)
    }
  })
})

describe('zip 条目路径安全', () => {
  const root = '/tmp/dest'
  const check = (name: string) => checkEntryPath(name, root, DEFAULT_LIMITS)

  it('拦截路径穿越', () => {
    expect(check('../../etc/passwd').safe).toBe(false)
  })

  it('拦截绝对路径', () => {
    expect(check('/etc/passwd').safe).toBe(false)
    expect(check('C:\\Windows\\x').safe).toBe(false)
  })

  it('拦截超深路径', () => {
    expect(check('a/'.repeat(30) + 'x.txt').safe).toBe(false)
  })

  it('拦截符号链接', () => {
    expect(checkEntryPath('link', root, DEFAULT_LIMITS, { isSymlink: true }).safe).toBe(false)
  })

  it('拦截打包残留与 NUL 字节', () => {
    expect(check('__MACOSX/._x').safe).toBe(false)
    expect(check('a\u0000b.txt').safe).toBe(false)
  })

  it('放行正常路径', () => {
    const r = check('project/demo.kicad_sch')
    expect(r.safe).toBe(true)
    if (r.safe) expect(r.target).toContain('demo.kicad_sch')
  })
})

describe('collectSvgArtifacts', () => {
  // kicad-cli 的 --output 有时是文件、有时是目录，多页原理图会产出多个 SVG。
  // 早先直接把 --output 参数当文件路径去读，遇到目录会整个解析失败。
  const roots: string[] = []
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'kicad-svg-'))
    roots.push(d)
    return d
  }

  afterAll(async () => {
    await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })))
  })

  it('目录下的多页 SVG 全部收集，顺序稳定', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'sch-svg'))
    for (const n of ['page2.svg', 'page1.svg', 'notes.txt']) {
      await writeFile(join(dir, 'sch-svg', n), 'x')
    }
    expect(await collectSvgArtifacts(dir, 'sch-svg')).toEqual([
      'sch-svg/page1.svg',
      'sch-svg/page2.svg',
    ])
  })

  it('单文件输出直接返回自身', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'board.svg'), 'x')
    expect(await collectSvgArtifacts(dir, 'board.svg')).toEqual(['board.svg'])
  })

  it('输出不存在时返回空数组而不是抛错', async () => {
    const dir = await tmp()
    expect(await collectSvgArtifacts(dir, 'pcb-svg')).toEqual([])
  })

  it('非 SVG 的单文件不被当成产物', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'netlist.net'), 'x')
    expect(await collectSvgArtifacts(dir, 'netlist.net')).toEqual([])
  })
})
