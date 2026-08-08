'use client'

import { cn } from '@app/ui'
import { useState } from 'react'
import { InvertingAmpSvg } from '@/components/schematic/InvertingAmpSvg'
import type { Component, DesignBundle } from '@/lib/api'

const TABS = ['原理图', 'PCB', 'BOM', 'ERC'] as const
type Tab = (typeof TABS)[number]

/** 中栏：原理图查看器（docs/03 页面 2）—— 缩放平移、选中描边、网络高亮开关 */
export function SchematicViewer({
  design,
  selected,
  onSelect,
}: {
  design: DesignBundle
  selected: Component | null
  onSelect: (c: Component | null) => void
}) {
  const [tab, setTab] = useState<Tab>('原理图')
  const [zoom, setZoom] = useState(100)
  const [netHighlight, setNetHighlight] = useState(true)

  const selectedNets = new Set(
    selected?.pins.map((p) => p.netName).filter((n): n is string => Boolean(n)) ?? [],
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-card border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <div className="flex items-center gap-1">
          {(['选择', '平移'] as const).map((t) => (
            <span key={t} className="rounded-md px-2 py-1 text-xs text-slate-500">
              {t}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 border-l border-slate-200 pl-2">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(50, z - 25))}
            className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            −
          </button>
          <span className="w-12 text-center text-xs text-slate-600">{zoom}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(200, z + 25))}
            className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom(100)}
            className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            适应
          </button>
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
          网络高亮
          <input
            type="checkbox"
            checked={netHighlight}
            onChange={(e) => setNetHighlight(e.target.checked)}
            className="h-3.5 w-7 appearance-none rounded-full bg-slate-300 transition-colors checked:bg-brand"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-4">
        {tab === '原理图' && (
          <div
            className="mx-auto origin-top transition-transform"
            style={{ transform: `scale(${zoom / 100})`, width: 640 }}
          >
            <InvertingAmpSvg className="w-full" />
            {netHighlight && selectedNets.size > 0 && (
              <p className="mt-2 text-center text-[11px] text-brand">
                高亮网络：{[...selectedNets].join('、')}
              </p>
            )}
          </div>
        )}

        {tab === 'PCB' && (
          <div className="flex h-full min-h-[300px] items-center justify-center text-xs text-slate-400">
            PCB 视图在 P5 与照片对齐一起接入
          </div>
        )}

        {tab === 'BOM' && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">位号</th>
                <th className="px-2 py-1.5 font-medium">值</th>
                <th className="px-2 py-1.5 font-medium">型号</th>
                <th className="px-2 py-1.5 font-medium">封装</th>
                <th className="px-2 py-1.5 font-medium">类别</th>
              </tr>
            </thead>
            <tbody>
              {design.components.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className={cn(
                    'cursor-pointer border-t border-slate-200/70 hover:bg-white',
                    c.id === selected?.id && 'bg-blue-50',
                  )}
                >
                  <td className="px-2 py-1 font-medium text-slate-800">{c.ref}</td>
                  <td className="px-2 py-1 text-slate-600">{c.value ?? '-'}</td>
                  <td className="px-2 py-1 text-slate-500">{c.partNumber ?? '-'}</td>
                  <td className="px-2 py-1 text-slate-500">{c.footprint ?? '-'}</td>
                  <td className="px-2 py-1 text-slate-500">{c.category ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'ERC' && (
          <ul className="space-y-2">
            {design.violations
              .filter((v) => v.origin === 'ERC' || v.origin === 'DRC')
              .map((v) => (
                <li key={v.id ?? v.code} className="rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                      {v.origin}
                    </span>
                    <span className="font-medium">{v.title}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">{v.description}</p>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="flex gap-1 border-t border-slate-100 px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-3 py-1 text-xs',
              tab === t ? 'bg-blue-50 font-medium text-brand' : 'text-slate-500 hover:bg-slate-100',
            )}
          >
            {t}
          </button>
        ))}
      </div>
    </section>
  )
}
