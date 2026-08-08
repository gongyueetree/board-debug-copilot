/**
 * 原理图规则引擎 —— docs/01「规则引擎」列出的 10 条 + I2C 上拉细化。
 *
 * 这一层是确定性的，永远先于 LLM 执行（docs/05 §2）。
 * 每条规则必须给出带具体数值或位号的 evidence，否则 grounding 层会丢掉它。
 */
import type { Finding } from '@app/contracts'
import { finding, type DesignGraph, type SchematicRule } from './types'

const POWER_ROLES = new Set(['POWER', 'BIAS'])
const isPowerPin = (t: string | null) => t === 'power_in' || t === 'power_out'

/** 从 "4.7k" / "100R" / "10uF" 解析成基本单位数值 */
export function parseValue(v: string | null | undefined): number | null {
  if (!v) return null
  const m = /^([\d.]+)\s*([pnumkKMR]?)/.exec(v.trim())
  if (!m?.[1]) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const mult: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    R: 1,
    '': 1,
    k: 1e3,
    K: 1e3,
    M: 1e6,
  }
  return n * (mult[m[2] ?? ''] ?? 1)
}

const powerNetMissing: SchematicRule = {
  code: 'POWER_NET_MISSING',
  title: '缺少电源网络',
  severity: 'CRITICAL',
  run: (g) => {
    const power = g.nets.filter((n) => POWER_ROLES.has(n.inferredRole ?? ''))
    if (power.length > 0) return []
    return [
      finding('POWER_NET_MISSING', 'CRITICAL', '缺少电源网络', {
        description: '网表中没有任何被识别为电源的网络，器件供电无法确认。',
        evidence: [`共 ${g.nets.length} 个网络，无一 inferredRole 为 POWER`],
        risk: '整板无法上电工作。',
        suggestion: '检查电源网络命名与标注。',
      }),
    ]
  },
}

const gndNetMissing: SchematicRule = {
  code: 'GND_NET_MISSING',
  title: '缺少地网络',
  severity: 'CRITICAL',
  run: (g) => {
    if (g.nets.some((n) => n.inferredRole === 'GND')) return []
    return [
      finding('GND_NET_MISSING', 'CRITICAL', '缺少地网络', {
        description: '网表中没有被识别为 GND 的网络。',
        evidence: [`共 ${g.nets.length} 个网络，无一 inferredRole 为 GND`],
        risk: '无参考地，所有电压测量失去基准。',
        suggestion: '补齐 GND 网络标注。',
      }),
    ]
  },
}

const singlePinNet: SchematicRule = {
  code: 'SINGLE_PIN_NET',
  title: '单引脚网络',
  severity: 'INFO',
  run: (g) =>
    g.nets
      .filter((n) => n.pinRefs.length === 1)
      .map((n) => {
        const p = n.pinRefs[0]!
        return finding('SINGLE_PIN_NET', 'INFO', `单引脚网络 ${n.name}`, {
          description: `网络 ${n.name} 只连接了一个引脚 ${p.componentRef}.${p.pinNumber}，可能是漏连或未标 no-connect。`,
          evidence: [`${n.name} 仅含 1 个引脚：${p.componentRef}.${p.pinNumber}`],
          risk: '若为漏连则该信号浮空。',
          suggestion: '确认是否应连接，或加 no-connect 标记。',
          componentRef: p.componentRef,
          netName: n.name,
        })
      }),
}

const floatingInput: SchematicRule = {
  code: 'FLOATING_INPUT',
  title: '输入引脚悬空',
  severity: 'WARNING',
  run: (g) =>
    g.components.flatMap((c) =>
      c.pins
        .filter((p) => p.type === 'input' && !p.netName)
        .map((p) =>
          finding('FLOATING_INPUT', 'WARNING', `${c.ref}.${p.number} 输入悬空`, {
            description: `${c.ref} 的输入引脚 ${p.number}（${p.name ?? '未命名'}）未连接到任何网络。`,
            evidence: [`${c.ref}.${p.number} netName 为空，引脚类型 input`],
            risk: 'CMOS 输入悬空会导致电平不定与额外功耗。',
            suggestion: '接到确定电平或加上下拉。',
            componentRef: c.ref,
          }),
        ),
    ),
}

/** 反相/同相放大器：反馈电阻与输入电阻决定增益，检查补偿电容取值 */
const opampFeedbackSuspect: SchematicRule = {
  code: 'OPAMP_FEEDBACK_SUSPECT',
  title: '运放反馈可疑',
  severity: 'WARNING',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    const opamps = g.components.filter((c) => c.category === '运算放大器')

    for (const u of opamps) {
      const inv = u.pins.find((p) => p.name === 'IN-')?.netName
      const out1 = u.pins.find((p) => p.name === 'OUT')?.netName
      if (!inv || !out1) continue

      // 同时连到反相端和输出端的元件，即反馈网络
      const fb = g.components.filter(
        (c) =>
          c.ref !== u.ref &&
          c.pins.some((p) => p.netName === inv) &&
          c.pins.some((p) => p.netName === out1),
      )
      const rf = fb.find((c) => c.category === '电阻')
      const cf = fb.find((c) => c.category === '电容')
      if (!rf || !cf) continue

      const r = parseValue(rf.value)
      const cap = parseValue(cf.value)
      if (!r || !cap) continue

      const fp = 1 / (2 * Math.PI * r * cap)
      const gbwRaw = String(u.meta.gbw ?? '')
      const gbw = /([\d.]+)\s*MHz/i.exec(gbwRaw)
      const gbwHz = gbw?.[1] ? Number(gbw[1]) * 1e6 : null

      if (gbwHz && fp > gbwHz / 50) continue

      out.push(
        finding('OPAMP_FEEDBACK_SUSPECT', 'WARNING', '反馈补偿电容偏小', {
          description: `${cf.ref} = ${cf.value} 与 ${rf.ref} = ${rf.value} 构成的极点在 ${(fp / 1000).toFixed(0)} kHz，相对 ${u.ref} 的带宽而言补偿偏弱。`,
          evidence: [
            `${cf.ref} = ${cf.value}`,
            `${rf.ref} = ${rf.value}`,
            `f_p = 1/(2π·${rf.value}·${cf.value}) ≈ ${(fp / 1000).toFixed(0)} kHz`,
            gbwHz ? `${u.ref} GBW = ${gbwRaw}` : `${u.ref} 未提供 GBW 参数`,
          ],
          risk: '高频增益过大，可能出现振铃或相位裕度不足。',
          suggestion: '按带宽需求重算补偿，或做闭环频响验证。',
          recommendedTest: '方波响应看过冲，或扫频测相位裕度',
          componentRef: u.ref,
          netName: out1,
        }),
      )
    }
    return out
  },
}

/** 开漏总线（I2C）必须有上拉；上拉阻值过大会拖慢上升沿 */
const i2cPullup: SchematicRule = {
  code: 'I2C_PULLUP_MISSING',
  title: 'I2C 上拉检查',
  severity: 'CRITICAL',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    for (const net of g.nets.filter((n) => n.inferredRole === 'I2C')) {
      const pullups = g.components.filter(
        (c) =>
          c.category === '电阻' &&
          c.pins.some((p) => p.netName === net.name) &&
          c.pins.some((p) => {
            const n = g.nets.find((x) => x.name === p.netName)
            return n?.inferredRole === 'POWER'
          }),
      )

      if (pullups.length === 0) {
        out.push(
          finding('I2C_PULLUP_MISSING', 'CRITICAL', `${net.name} 缺少上拉电阻`, {
            description: `${net.name} 是开漏总线，但没有找到接到电源的上拉电阻。`,
            evidence: [`${net.name} 上的元件：${net.pinRefs.map((p) => p.componentRef).join(', ')}`],
            risk: '总线无法拉高，通信完全失败。',
            suggestion: '在 3V3 与总线之间加 2.2k~4.7k 上拉。',
            recommendedTest: '示波器看总线空闲电平是否为高',
            netName: net.name,
          }),
        )
        continue
      }

      for (const r of pullups) {
        const ohm = parseValue(r.value)
        if (ohm && ohm > 4000) {
          out.push(
            finding('I2C_PULLUP_MISSING', 'CRITICAL', 'I2C 上拉阻值偏大', {
              description: `${net.name} 上拉电阻 ${r.ref} = ${r.value}。若总线速率提高到 400kHz 或总线电容超过 200pF，上升沿会过慢导致采样失败。`,
              evidence: [
                `${r.ref} = ${r.value} 上拉 ${net.name}`,
                `400kHz 快速模式要求上升沿 < 300ns`,
                `RC 时间常数 ≈ ${((ohm * 200e-12 * 1e9) | 0)} ns（按 200pF 总线电容估算）`,
              ],
              risk: '通信可靠性下降，可能出现 ACK 失败或数据错位。',
              suggestion: '评估总线电容，400kHz 下建议减小到 2.2kΩ。',
              recommendedTest: '示波器看 SCL 上升沿时间，应 < 300ns',
              componentRef: r.ref,
              netName: net.name,
            }),
          )
        }
      }
    }
    return out
  },
}

const openDrainNoPullup: SchematicRule = {
  code: 'OPEN_DRAIN_NO_PULLUP',
  title: '开漏引脚缺上拉',
  severity: 'INFO',
  run: (g) =>
    g.components.flatMap((c) =>
      c.pins
        .filter((p) => p.name === 'A0' || p.name === 'A1' || p.name === 'A2')
        .filter((p) => {
          const n = g.nets.find((x) => x.name === p.netName)
          return n?.inferredRole === 'GND'
        })
        .map((p) =>
          finding('OPEN_DRAIN_NO_PULLUP', 'INFO', `${c.ref} 地址脚固定接地`, {
            description: `${c.ref}.${p.name} 接 GND，器件地址被固定，无法在同一总线上扩展多片。`,
            evidence: [`${c.ref}.${p.name} → GND`, `当前地址：${String(c.meta.address ?? '未知')}`],
            risk: '影响较小，仅限制扩展性。',
            suggestion: '如需多片并联，改用可配置地址。',
            componentRef: c.ref,
          }),
        ),
    ),
}

const decouplingInsufficient: SchematicRule = {
  code: 'DECOUPLING_INSUFFICIENT',
  title: '去耦不足',
  severity: 'INFO',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    const ics = g.components.filter((c) =>
      ['运算放大器', 'DAC', 'MCU'].includes(c.category ?? ''),
    )
    for (const ic of ics) {
      const rails = new Set(
        ic.pins
          .filter((p) => isPowerPin(p.type) && p.netName)
          .map((p) => p.netName as string)
          .filter((n) => g.nets.find((x) => x.name === n)?.inferredRole === 'POWER'),
      )
      for (const rail of rails) {
        const caps = g.components.filter(
          (c) =>
            c.category === '电容' &&
            c.pins.some((p) => p.netName === rail) &&
            c.pins.some((p) => g.nets.find((x) => x.name === p.netName)?.inferredRole === 'GND'),
        )
        const near = caps.filter((c) => String(c.meta.role ?? '').includes('去耦'))
        if (near.length === 0) {
          out.push(
            finding('DECOUPLING_INSUFFICIENT', 'INFO', `${ic.ref} 去耦偏少`, {
              description: `${ic.ref} 的 ${rail} 供电上没有标注为去耦的电容，仅共用电源平面上的电容。`,
              evidence: [`${ic.ref} 供电网络 ${rail}`, `该网络上电容 ${caps.length} 颗，无一标注去耦`],
              risk: '高频电源噪声抑制不足。',
              suggestion: '在电源引脚旁就近加 100nF。',
              componentRef: ic.ref,
              netName: rail,
            }),
          )
        }
      }
    }
    return out
  },
}

const ldoCapMissing: SchematicRule = {
  code: 'LDO_CAP_MISSING',
  title: 'LDO 电容检查',
  severity: 'WARNING',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    for (const ldo of g.components.filter((c) => c.category === 'LDO 稳压器')) {
      const outNet = ldo.pins.find((p) => p.name === 'OUT')?.netName
      if (!outNet) continue
      const caps = g.components.filter(
        (c) => c.category === '电容' && c.pins.some((p) => p.netName === outNet),
      )
      const totalF = caps.reduce((a, c) => a + (parseValue(c.value) ?? 0), 0)
      if (totalF < 10e-6) {
        out.push(
          finding('LDO_CAP_MISSING', 'WARNING', 'LDO 输出电容余量不足', {
            description: `${ldo.ref} 输出侧总容量约 ${(totalF * 1e6).toFixed(2)} µF，负载瞬态较大时压降偏多。`,
            evidence: [
              `${outNet} 上电容：${caps.map((c) => `${c.ref} ${c.value}`).join('、') || '无'}`,
              `合计 ${(totalF * 1e6).toFixed(2)} µF，建议 ≥ 10 µF`,
              `${ldo.ref} Iout = ${String(ldo.meta.iout ?? '未知')}`,
            ],
            risk: '负载跳变时输出出现瞬态跌落，可能影响下游器件。',
            suggestion: '输出侧补一颗 10µF。',
            componentRef: ldo.ref,
            netName: outNet,
          }),
        )
      }
    }
    return out
  },
}

const resetPinFloating: SchematicRule = {
  code: 'RESET_PIN_FLOATING',
  title: '复位脚悬空',
  severity: 'WARNING',
  run: (g) =>
    g.components.flatMap((c) =>
      c.pins
        .filter((p) => /reset|nrst|rst/i.test(p.name ?? '') && !p.netName)
        .map((p) =>
          finding('RESET_PIN_FLOATING', 'WARNING', `${c.ref} 复位脚悬空`, {
            description: `${c.ref}.${p.number}（${p.name}）未连接。`,
            evidence: [`${c.ref}.${p.number} 名称匹配复位，netName 为空`],
            risk: '器件可能随机复位或无法复位。',
            suggestion: '加上拉电阻与复位电容。',
            componentRef: c.ref,
          }),
        ),
    ),
}

const connectorUnprotected: SchematicRule = {
  code: 'CONNECTOR_UNPROTECTED',
  title: '连接器缺少保护',
  severity: 'WARNING',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    const tvs = g.components.filter((c) => /TVS|ESD|SMAJ|PESD/i.test(c.partNumber ?? c.value ?? ''))
    if (tvs.length > 0) return []

    for (const j of g.components.filter((c) => c.category === '连接器')) {
      const sig = j.pins.find((p) => p.name === 'SIG')
      if (!sig?.netName) continue
      out.push(
        finding('CONNECTOR_UNPROTECTED', 'WARNING', `${j.ref} 缺少保护`, {
          description: `${j.ref}（${j.value ?? ''}）是板外接口，网表中未见 TVS 或反接保护器件。`,
          evidence: [`${j.ref}.${sig.number} → ${sig.netName}`, '全板未检索到 TVS/ESD 器件'],
          risk: '外部异常电压可能击穿相邻器件输入级。',
          suggestion: '输入端加 TVS 或反并联二极管做二级钳位。',
          componentRef: j.ref,
          netName: sig.netName,
        }),
      )
    }
    return out
  },
}

/** 单电源反相放大器必须把同相端偏置到轨中点，接地是典型设计缺陷 */
const supplyHeadroom: SchematicRule = {
  code: 'SUPPLY_HEADROOM_INSUFFICIENT',
  title: '单电源缺 Vref 偏置',
  severity: 'CRITICAL',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    for (const u of g.components.filter((c) => c.category === '运算放大器')) {
      const vplus = u.pins.find((p) => p.name === 'V+')?.netName
      const vminus = u.pins.find((p) => p.name === 'V-')?.netName
      const inPlus = u.pins.find((p) => p.name === 'IN+')?.netName
      if (!vplus || !vminus || !inPlus) continue

      const vminusIsGnd = g.nets.find((n) => n.name === vminus)?.inferredRole === 'GND'
      const inPlusIsGnd = g.nets.find((n) => n.name === inPlus)?.inferredRole === 'GND'
      if (!vminusIsGnd || !inPlusIsGnd) continue

      out.push(
        finding('SUPPLY_HEADROOM_INSUFFICIENT', 'CRITICAL', '单电源缺 Vref 偏置', {
          description: `${u.ref} 工作在单电源下的反相放大结构，同相端 ${u.ref}.3 直接接 GND。反相放大输出只能相对同相端电位摆动，同相端为 0V 时输出无法向下摆，被钳在轨底约 0V。`,
          evidence: [
            `${u.ref} IN+ 网络为 ${inPlus}（GND），非预期的偏置网络`,
            `${u.ref} V- = ${vminus}（GND），V+ = ${vplus}，确为单电源供电`,
            `供电范围 ${String(u.meta.supplyRange ?? '未知')}`,
          ],
          risk: '输出恒为 0V，放大器完全不工作。',
          suggestion: '在同相端与 GND/电源之间加分压产生轨中点偏置，并用电容旁路；或改用双电源。',
          recommendedTest: '用 DMM 测同相端对地直流电压，预期为供电电压的一半',
          componentRef: u.ref,
          netName: inPlus,
        }),
      )
    }
    return out
  },
}

/** 单电源下增益过大 → 可用输入范围过窄 */
const outputSwingClipping: SchematicRule = {
  code: 'OUTPUT_SWING_CLIPPING_RISK',
  title: '输出摆幅削顶风险',
  severity: 'CRITICAL',
  run: (g) => {
    const out: Omit<Finding, 'origin'>[] = []
    for (const u of g.components.filter((c) => c.category === '运算放大器')) {
      const inv = u.pins.find((p) => p.name === 'IN-')?.netName
      const outNet = u.pins.find((p) => p.name === 'OUT')?.netName
      const vplus = u.pins.find((p) => p.name === 'V+')?.netName
      if (!inv || !outNet || !vplus) continue

      const rf = g.components.find(
        (c) =>
          c.category === '电阻' &&
          c.pins.some((p) => p.netName === inv) &&
          c.pins.some((p) => p.netName === outNet),
      )
      const rin = g.components.find(
        (c) =>
          c.category === '电阻' &&
          c.ref !== rf?.ref &&
          c.pins.some((p) => p.netName === inv) &&
          c.pins.some((p) => g.nets.find((n) => n.name === p.netName)?.inferredRole === 'SIGNAL'),
      )
      const rfV = parseValue(rf?.value)
      const rinV = parseValue(rin?.value)
      if (!rf || !rin || !rfV || !rinV) continue

      const gain = rfV / rinV
      const rail = Number(
        /([\d.]+)/.exec(g.nets.find((n) => n.name === vplus)?.expectedVoltage ?? '')?.[1] ?? 0,
      )
      if (!rail || gain < 5) continue

      const swing = rail - 0.04
      const maxInput = swing / gain

      out.push(
        finding('OUTPUT_SWING_CLIPPING_RISK', 'CRITICAL', '输出摆幅削顶风险', {
          description: `单电源 ${rail}V 下 ${u.ref} 最大输出摆幅约 ${swing.toFixed(2)} Vpp。设计增益 -${gain.toFixed(0)} 时，输入超过约 ${maxInput.toFixed(2)} Vpp 输出即削顶，可用输入范围过窄。`,
          evidence: [
            `${u.ref} 输出 ${String(u.meta.output ?? '轨到轨')}，${rail}V 轨下摆幅上限 ${swing.toFixed(2)} Vpp`,
            `设计增益 |Av| = ${rf.ref}/${rin.ref} = ${rf.value}/${rin.value} = ${gain.toFixed(0)}`,
            `不削顶的输入上限 = ${swing.toFixed(2)}/${gain.toFixed(0)} = ${maxInput.toFixed(3)} Vpp`,
          ],
          risk: '输入稍大即产生严重谐波失真，传感器动态范围被压缩。',
          suggestion: `降低增益到 -5 以内，或提高供电以增加输出余量。`,
          recommendedTest: `扫输入幅度 0.1~${(maxInput * 2).toFixed(1)} Vpp，观察 THD+N 拐点`,
          componentRef: u.ref,
          netName: outNet,
        }),
      )
    }
    return out
  },
}

export const SCHEMATIC_RULES: SchematicRule[] = [
  powerNetMissing,
  gndNetMissing,
  singlePinNet,
  floatingInput,
  opampFeedbackSuspect,
  i2cPullup,
  openDrainNoPullup,
  decouplingInsufficient,
  ldoCapMissing,
  resetPinFloating,
  connectorUnprotected,
  supplyHeadroom,
  outputSwingClipping,
]

/** 运行全部规则，输出 origin=RULE_ENGINE 的 Finding */
export function runSchematicRules(graph: DesignGraph): Finding[] {
  return SCHEMATIC_RULES.flatMap((rule) => {
    try {
      return rule.run(graph).map((f) => ({ ...f, origin: 'RULE_ENGINE' as const }))
    } catch (err) {
      // 单条规则出错不能让整个审查失败
      console.error(`[rules] ${rule.code} 执行失败:`, (err as Error).message)
      return []
    }
  })
}
