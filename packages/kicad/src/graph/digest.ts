/**
 * DesignDigest —— docs/05 §4.2 的紧凑 DSL。
 *
 * 把 Prisma JSON 直接塞进 prompt 是最常见的失败点：一个项目轻松 30k token 且信噪比极低。
 * [TOPOLOGY] 段对输出质量的贡献大于其它所有段落之和 —— 没有它 LLM 只能从网表猜电路功能。
 */
import type { DesignGraph } from '../rules/types'
import { parseValue } from '../rules/schematic-rules'

export interface DigestInput {
  projectName: string
  currentIssue: string | null
  graph: DesignGraph
  testPoints: { label: string; netName: string | null }[]
}

/** 识别运放拓扑：反相/同相放大，反馈与输入电阻，增益，供电方式 */
export function detectOpampTopology(g: DesignGraph): string[] {
  const lines: string[] = []

  for (const u of g.components.filter((c) => c.category === '运算放大器')) {
    const inv = u.pins.find((p) => p.name === 'IN-')?.netName
    const inp = u.pins.find((p) => p.name === 'IN+')?.netName
    const outNet = u.pins.find((p) => p.name === 'OUT')?.netName
    const vplus = u.pins.find((p) => p.name === 'V+')?.netName
    const vminus = u.pins.find((p) => p.name === 'V-')?.netName
    if (!inv || !outNet) continue

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
    const gain = rfV && rinV ? -(rfV / rinV) : null
    const single = g.nets.find((n) => n.name === vminus)?.inferredRole === 'GND'

    lines.push(
      `  ${u.ref}: inverting-amp  Rin=${rin?.ref}(${rin?.value}) Rf=${rf?.ref}(${rf?.value})` +
        (gain ? ` gain=${gain.toFixed(0)}` : '') +
        `  supply=${single ? `single-${vplus}` : `dual(${vplus}/${vminus})`}`,
    )

    if (single && inp && g.nets.find((n) => n.name === inp)?.inferredRole === 'GND') {
      lines.push(
        `      note: 单电源下 ${u.ref} 同相端必须偏置到轨中点；当前网表 ${u.ref}.IN+ 接 ${inp}`,
        `            → 反相输出只能向下摆，被钳在轨底 ≈ 0V`,
      )
    }
    if (gain && vplus) {
      const rail = Number(
        /([\d.]+)/.exec(g.nets.find((n) => n.name === vplus)?.expectedVoltage ?? '')?.[1] ?? 0,
      )
      if (rail) {
        lines.push(
          `      note: ${rail}V 轨下最大摆幅 ≈ ${(rail - 0.04).toFixed(2)}Vpp，增益 ${Math.abs(gain).toFixed(0)}` +
            ` → 可用输入上限仅 ${((rail - 0.04) / Math.abs(gain)).toFixed(2)}Vpp`,
        )
      }
    }

    // DNP 并联位：常见装配故障来源
    const dnp = g.components.filter((c) => c.meta.dnp === true)
    for (const d of dnp) {
      lines.push(
        `      note: ${d.ref}(${d.value}) 设计为 DNP；若误贴或与 ${rf?.ref} 桥接则 Rf 等效减半，增益随之减半`,
      )
    }
  }
  return lines
}

export function buildDesignDigest(input: DigestInput): string {
  const { graph: g } = input
  const out: string[] = []

  out.push(`[PROJECT] ${input.projectName} | issue: ${input.currentIssue ?? '未描述'}`)

  const powerNets = g.nets.filter((n) => n.inferredRole === 'POWER' || n.inferredRole === 'BIAS')
  out.push(
    `[SUPPLY] ${powerNets.map((n) => `${n.name} (${n.expectedVoltage ?? '?'})`).join(' | ')} | GND`,
  )

  out.push(`[COMPONENTS] ${g.components.length}`)
  const byCat = new Map<string, typeof g.components>()
  for (const c of g.components) {
    const k = c.category ?? '其他'
    byCat.set(k, [...(byCat.get(k) ?? []), c])
  }
  for (const [cat, list] of byCat) {
    // 有源器件逐个展开并带参数，无源器件按类聚合
    if (['运算放大器', 'DAC', 'LDO 稳压器', 'MCU'].includes(cat)) {
      for (const c of list) {
        const params = Object.entries(c.meta)
          .filter(([k]) => k !== 'category' && k !== 'role' && k !== 'note')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
        out.push(`  ${c.ref} ${c.value ?? ''} ${c.partNumber ?? ''} ${params}`.trimEnd())
      }
    } else {
      out.push(
        `  ${cat} x${list.length}: ` +
          list
            .map((c) => `${c.ref}(${c.value ?? '?'}${c.meta.role ? ` ${c.meta.role}` : ''})`)
            .join(' '),
      )
    }
  }

  out.push(`[NETS] ${g.nets.length}`)
  for (const n of g.nets) {
    const pins = n.pinRefs.map((p) => `${p.componentRef}.${p.pinNumber}`).join(',')
    out.push(
      `  ${n.name.padEnd(10)} role=${n.inferredRole ?? '?'}` +
        (n.expectedVoltage ? ` exp=${n.expectedVoltage}` : '') +
        `  pins=${pins}`,
    )
  }

  const topo = detectOpampTopology(g)
  if (topo.length > 0) {
    out.push('[TOPOLOGY]')
    out.push(...topo)
  }

  if (input.testPoints.length > 0) {
    out.push(
      `[TESTPOINTS] ${input.testPoints.map((t) => `${t.label}=${t.netName ?? '?'}`).join(' ')}`,
    )
  }

  return out.join('\n')
}
