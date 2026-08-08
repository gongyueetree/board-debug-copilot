/**
 * KiCad netlist (S-expression) 解析。
 *
 * kicad-cli 导出的 .net 是 S-expr，结构稳定：(export (components (comp (ref "U1") ...))
 * (nets (net (code 1) (name "GND") (node (ref "U1") (pin "4")) ...)))
 *
 * 只解析这两段 —— 规则引擎需要的就是组件、引脚、网络三者的连接关系。
 */
import type { DesignGraph } from '../rules/types'

type SExpr = string | SExpr[]

export function parseSExpr(src: string): SExpr[] {
  const tokens = src
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .match(/"(?:[^"\\]|\\.)*"|[^\s()]+|[()]/g)
  if (!tokens) return []

  let i = 0
  const walk = (): SExpr => {
    const t = tokens[i++]!
    if (t === '(') {
      const list: SExpr[] = []
      while (i < tokens.length && tokens[i] !== ')') list.push(walk())
      i++ // 吃掉 ')'
      return list
    }
    return t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t
  }

  const out: SExpr[] = []
  while (i < tokens.length) out.push(walk())
  return out
}

const isList = (n: SExpr): n is SExpr[] => Array.isArray(n)
const head = (n: SExpr): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null)
const find = (n: SExpr[], key: string): SExpr[] | null =>
  (n.find((c) => head(c) === key) as SExpr[] | undefined) ?? null
const findAll = (n: SExpr[], key: string): SExpr[][] =>
  n.filter((c) => head(c) === key) as SExpr[][]
const value = (n: SExpr[], key: string): string | null => {
  const node = find(n, key)
  return node && typeof node[1] === 'string' ? node[1] : null
}

/** 从器件值/封装推断类别，供规则引擎与 DesignDigest 使用 */
export function inferCategory(ref: string, value: string | null, footprint: string | null): string {
  const v = (value ?? '').toUpperCase()
  const f = (footprint ?? '').toUpperCase()
  if (/^R\d/.test(ref)) return '电阻'
  if (/^C\d/.test(ref) || /^CDEC/i.test(ref)) return '电容'
  if (/^L\d/.test(ref)) return '电感'
  if (/^D\d/.test(ref)) return '二极管'
  if (/^Q\d/.test(ref)) return '晶体管'
  if (/^J\d|^P\d/.test(ref) || f.includes('CONN') || f.includes('SMA')) return '连接器'
  if (/^TP\d/.test(ref)) return '测试点'
  if (/^U\d/.test(ref)) {
    if (/OPA|AD8|LM3|TL07|MCP6|ADA4/.test(v)) return '运算放大器'
    if (/DAC|MCP47/.test(v)) return 'DAC'
    if (/ADC|ADS1/.test(v)) return 'ADC'
    if (/LDO|TPS7|AMS11|LM1117|MIC5/.test(v)) return 'LDO 稳压器'
    if (/STM32|ATMEGA|ESP32|NRF|RP2040/.test(v)) return 'MCU'
    return '集成电路'
  }
  return '其他'
}

/** 从引脚名推断类型；netlist 里 node 可能带 pintype，没有时用名字兜底 */
export function inferPinType(name: string | null, declared: string | null): string {
  if (declared && declared !== 'unspecified') return declared
  const n = (name ?? '').toUpperCase()
  if (/^(VCC|VDD|VSS|GND|V\+|V-|VIN|VOUT_LDO|AVDD)$/.test(n)) return 'power_in'
  if (/^(OUT|VOUT)/.test(n)) return 'output'
  if (/^(IN|VIN|A\d|EN|RESET|NRST)/.test(n)) return 'input'
  if (/^(SDA|SCL|SPI|IO)/.test(n)) return 'bidirectional'
  if (/^NC$/.test(n)) return 'no_connect'
  return 'passive'
}

/** 从网络名推断角色 */
export function inferNetRole(name: string): string {
  const n = name.toUpperCase()
  if (/^(GND|AGND|DGND|VSS)$/.test(n)) return 'GND'
  if (/^(VCC|VDD|\+?\d+V\d*|\+\d+V|3V3|5V|1V8)$/.test(n)) return 'POWER'
  if (/VREF|BIAS/.test(n)) return 'BIAS'
  if (/^(SDA|SCL)$/.test(n)) return 'I2C'
  if (/^(MOSI|MISO|SCK|CS)$/.test(n)) return 'SPI'
  return 'SIGNAL'
}

export function parseNetlist(src: string): DesignGraph {
  const root = parseSExpr(src)
  const exp = (root[0] as SExpr[] | undefined) ?? []

  const compsNode = find(exp, 'components') ?? []
  const netsNode = find(exp, 'nets') ?? []

  const pinsByRef = new Map<string, DesignGraph['components'][number]['pins']>()
  const nets: DesignGraph['nets'] = []

  for (const net of findAll(netsNode, 'net')) {
    const name = value(net, 'name') ?? `N${value(net, 'code') ?? '?'}`
    const pinRefs: DesignGraph['nets'][number]['pinRefs'] = []

    for (const node of findAll(net, 'node')) {
      const ref = value(node, 'ref')
      const pin = value(node, 'pin')
      if (!ref || !pin) continue
      const pinName = value(node, 'pinfunction')
      const pinType = value(node, 'pintype')

      pinRefs.push({ componentRef: ref, pinNumber: pin, pinName })
      const list = pinsByRef.get(ref) ?? []
      list.push({
        number: pin,
        name: pinName,
        type: inferPinType(pinName, pinType),
        netName: name,
      })
      pinsByRef.set(ref, list)
    }

    nets.push({ name, inferredRole: inferNetRole(name), expectedVoltage: null, pinRefs })
  }

  const components: DesignGraph['components'] = findAll(compsNode, 'comp').map((c) => {
    const ref = value(c, 'ref') ?? '?'
    const val = value(c, 'value')
    const footprint = value(c, 'footprint')
    return {
      ref,
      value: val,
      category: inferCategory(ref, val, footprint),
      partNumber: null,
      meta: { category: inferCategory(ref, val, footprint), footprint },
      pins: pinsByRef.get(ref) ?? [],
    }
  })

  return { components, nets }
}
