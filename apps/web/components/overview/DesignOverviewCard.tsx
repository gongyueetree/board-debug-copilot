'use client'

import { SectionCard } from '@app/ui'
import Link from 'next/link'
import { useState } from 'react'
import { InvertingAmpSvg } from '@/components/schematic/InvertingAmpSvg'
import type { DesignBundle } from '@/lib/api'

const TABS = ['Schematic', 'PCB', 'BOM'] as const
type Tab = (typeof TABS)[number]

const KEY_ROLES = ['运算放大器', 'DAC', 'LDO 稳压器'] as const
const KEY_NETS = ['VIN_SENS', 'VOUT_AMP', 'VREF', '3V3', 'GND'] as const

export function DesignOverviewCard({
  design,
  projectId,
}: {
  design: DesignBundle
  projectId: string
}) {
  const [tab, setTab] = useState<Tab>('Schematic')

  const keyParts = design.components.filter(
    (c) => c.category && (KEY_ROLES as readonly string[]).includes(c.category),
  )
  const passives = design.components.filter(
    (c) => c.category === '电阻' || c.category === '电容',
  )
  const nets = design.nets.filter((n) => (KEY_NETS as readonly string[]).includes(n.name))

  return (
    <SectionCard
      title="设计概览"
      action={
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'rounded-md bg-white px-2.5 py-1 text-xs font-medium text-brand shadow-sm'
                  : 'rounded-md px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700'
              }
            >
              {t}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_170px]">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
          {tab === 'Schematic' && <InvertingAmpSvg className="h-[180px] w-full" />}
          {tab === 'PCB' && (
            <div className="flex h-[180px] flex-col items-center justify-center gap-1 text-xs text-slate-500">
              <span>PCB 视图在 P5 接入</span>
              <span className="text-slate-400">
                {design.components.length} 个器件已带坐标，可直接渲染
              </span>
            </div>
          )}
          {tab === 'BOM' && (
            <div className="h-[180px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">位号</th>
                    <th className="px-2 py-1 font-medium">值</th>
                    <th className="px-2 py-1 font-medium">封装</th>
                  </tr>
                </thead>
                <tbody className="text-slate-700">
                  {design.components.map((c) => (
                    <tr key={c.id} className="border-t border-slate-200/70">
                      <td className="px-2 py-1 font-medium">{c.ref}</td>
                      <td className="px-2 py-1">{c.value ?? '-'}</td>
                      <td className="px-2 py-1 text-slate-500">{c.footprint ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="text-xs">
          <div className="font-medium text-slate-900">电路功能</div>
          <p className="mt-1 text-slate-500">反相放大器 / 传感器信号调理</p>

          <div className="mt-3 font-medium text-slate-900">关键器件</div>
          <ul className="mt-1 space-y-0.5 text-slate-600">
            {keyParts.map((c) => (
              <li key={c.id}>
                <span className="font-medium text-slate-800">{c.ref}</span> {c.value}
              </li>
            ))}
            {passives.length > 0 && (
              <li className="text-slate-500">
                无源器件 {passives.length} 颗（Rin 10k / Rf 100k / Cdec 100nF×6）
              </li>
            )}
          </ul>

          <div className="mt-3 font-medium text-slate-900">关键网络</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {nets.map((n) => (
              <span
                key={n.id}
                className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-brand"
                title={n.expectedVoltage ?? undefined}
              >
                {n.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span>
          {design.components.length} 器件 · {design.nets.length} 网络 · {design.testPoints.length}{' '}
          测试点
        </span>
        <Link href={`/projects/${projectId}/design`} className="font-medium text-brand">
          查看完整设计 →
        </Link>
      </div>
    </SectionCard>
  )
}
