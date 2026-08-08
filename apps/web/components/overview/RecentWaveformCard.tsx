'use client'

import {
  CHANNEL_COLORS,
  SectionCard,
  WaveformCanvas,
  autoVoltsPerDiv,
  synthesizeSine,
} from '@app/ui'
import Link from 'next/link'
import { useMemo } from 'react'
import type { CaptureSummary } from '@/lib/api'

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="text-xs font-medium text-slate-800">{value}</div>
    </div>
  )
}

function Channel({
  tag,
  color,
  samples,
  voltsPerDiv,
  metrics,
}: {
  tag: string
  color: string
  samples: number[]
  voltsPerDiv: number
  metrics: { label: string; value: string }[]
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium" style={{ color }}>
          <span className="h-2 w-2 rounded-full" style={{ background: color }} />
          {tag}
        </span>
        <span className="text-slate-400">
          {voltsPerDiv} V/div · 500 µs/div · 1 MSa/s
        </span>
      </div>
      <div className="h-[76px]">
        <WaveformCanvas traces={[{ samples, color }]} />
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {metrics.map((m) => (
          <Metric key={m.label} {...m} />
        ))}
      </div>
    </div>
  )
}

/**
 * 最近测试波形（docs/03 页面 1）。
 * 波形原始数组不入库，这里按 measurementsJson 摘要合成正弦渲染。
 */
export function RecentWaveformCard({
  captures,
  projectId,
}: {
  captures: CaptureSummary[]
  projectId: string
}) {
  const latest = captures.filter((c) => c.measurements !== null).at(-1)
  const measurements = latest?.measurements ?? null

  const traces = useMemo(() => {
    if (!measurements) return null
    const m = measurements
    const live = m.ch2.vpp > 0
    const vdiv1 = autoVoltsPerDiv(m.ch1.vpp)
    const vdiv2 = autoVoltsPerDiv(m.ch2.vpp || 1)
    // 单电源 5V + AD8605 轨到轨余量 ±20mV：先按 2.5V 偏置生成再钳位，
    // 削顶场景（CH2 4.92Vpp）就会真的画出平顶，而不是靠画一条被压扁的正弦冒充
    return {
      vdiv1,
      vdiv2,
      ch1: synthesizeSine({ vpp: m.ch1.vpp, offsetV: 0, voltsPerDiv: vdiv1, cycles: 3 }),
      ch2: synthesizeSine({
        vpp: m.ch2.vpp,
        offsetV: live ? 2.5 : 0,
        voltsPerDiv: vdiv2,
        cycles: 3,
        phaseDeg: m.phaseDeg,
        clipTo: live ? [0.02, 4.98] : undefined,
        acCoupled: true,
      }),
    }
  }, [measurements])

  if (!latest || !measurements || !traces) {
    return (
      <SectionCard title="最近测试波形">
        <p className="py-8 text-center text-xs text-slate-400">暂无示波器捕获</p>
      </SectionCard>
    )
  }

  const m = measurements

  return (
    <SectionCard
      title="最近测试波形"
      action={
        <Link href={`/projects/${projectId}/bench`} className="text-xs font-medium text-brand">
          查看全部（{captures.length}）
        </Link>
      }
    >
      <div className="space-y-3">
        <Channel
          tag="CH1: TP1 (IN)"
          color={CHANNEL_COLORS.ch1}
          samples={traces.ch1}
          voltsPerDiv={traces.vdiv1}
          metrics={[
            { label: 'Vpp', value: `${m.ch1.vpp.toFixed(3)} V` },
            { label: 'Freq', value: `${(m.ch1.freqHz / 1000).toFixed(3)} kHz` },
            { label: 'Vmax', value: `${m.ch1.vmax.toFixed(2)} V` },
            { label: 'Vmin', value: `${m.ch1.vmin.toFixed(2)} V` },
            { label: 'DC 偏置', value: `${(m.ch1.offsetV * 1000).toFixed(1)} mV` },
          ]}
        />
        <Channel
          tag="CH2: TP2 (OUT)"
          color={CHANNEL_COLORS.ch2}
          samples={traces.ch2}
          voltsPerDiv={traces.vdiv2}
          metrics={[
            { label: 'Vpp', value: `${m.ch2.vpp.toFixed(3)} V` },
            { label: 'Freq', value: `${(m.ch2.freqHz / 1000).toFixed(3)} kHz` },
            { label: 'Gain', value: `${m.gain.toFixed(2)} V/V` },
            { label: 'Phase', value: `${m.phaseDeviationDeg.toFixed(1)}°` },
            { label: 'THD+N', value: `${(m.ch2.thdnPct ?? 0).toFixed(2)} %` },
          ]}
        />
      </div>
      <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
        {latest.label} · 增益与相位基于基波（1.000 kHz）计算，Phase 为相对反相理想值 180° 的偏差
      </p>
    </SectionCard>
  )
}
