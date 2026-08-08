'use client'

import { RiskPill, cn } from '@app/ui'
import { useMemo, useState } from 'react'
import type { Component, DesignBundle } from '@/lib/api'

/** 左栏：组件与筛选（docs/03 页面 2） */
export function ComponentTree({
  design,
  selected,
  onSelect,
}: {
  design: DesignBundle
  selected: Component | null
  onSelect: (c: Component | null) => void
}) {
  const [q, setQ] = useState('')
  const [cats, setCats] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return design.components.filter((c) => {
      if (cats.size > 0 && !cats.has(c.category ?? '其他')) return false
      if (!kw) return true
      return [c.ref, c.value, c.partNumber, c.category]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(kw))
    })
  }, [design.components, q, cats])

  const toggle = (name: string) =>
    setCats((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const related = selected
    ? design.components.filter(
        (c) =>
          c.id !== selected.id &&
          c.pins.some((p) => p.netName && selected.pins.some((sp) => sp.netName === p.netName)),
      )
    : []

  const issues = selected
    ? design.violations.filter((v) => v.componentRef === selected.ref)
    : []

  return (
    <aside className="flex w-[260px] shrink-0 flex-col gap-3 overflow-auto">
      <div className="rounded-card border border-slate-200 bg-white p-3">
        <div className="mb-2 text-sm font-semibold">组件与筛选</div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索组件（如 U1、R1、AD8605）"
          className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none"
        />

        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="font-medium text-slate-700">类别</span>
          {cats.size > 0 && (
            <button type="button" onClick={() => setCats(new Set())} className="text-brand">
              清除筛选
            </button>
          )}
        </div>
        <ul className="mt-1 space-y-0.5">
          {design.categories.map((c) => (
            <li key={c.name}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-slate-50',
                  cats.has(c.name) && 'bg-blue-50 text-brand',
                )}
              >
                <input
                  type="checkbox"
                  checked={cats.has(c.name)}
                  onChange={() => toggle(c.name)}
                  className="h-3 w-3 accent-blue-600"
                />
                <span className="flex-1">{c.name}</span>
                <span className="text-slate-400">{c.count}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-card border border-slate-200 bg-white p-3">
        <div className="mb-2 text-sm font-semibold">组件列表（{visible.length}）</div>
        <ul className="max-h-[220px] space-y-0.5 overflow-auto">
          {visible.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id === selected?.id ? null : c)}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-slate-50',
                  c.id === selected?.id && 'bg-blue-50 font-medium text-brand',
                )}
              >
                <span className="w-12 shrink-0 font-medium">{c.ref}</span>
                <span className="truncate text-slate-500">{c.value}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected && (
        <div className="rounded-card border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{selected.ref}</span>
            <span className="text-xs text-slate-500">{selected.value}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {selected.category} · {selected.footprint}
          </p>

          <dl className="mt-2 space-y-1 text-[11px]">
            {selected.partNumber && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">型号</dt>
                <dd className="text-slate-700">{selected.partNumber}</dd>
              </div>
            )}
            {selected.manufacturer && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">制造商</dt>
                <dd className="text-slate-700">{selected.manufacturer}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-slate-400">引脚</dt>
              <dd className="text-slate-700">
                {selected.pins.filter((p) => p.netName).length}/{selected.pins.length} 已连接
              </dd>
            </div>
          </dl>

          <div className="mt-2 flex flex-wrap gap-1">
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] text-red-600">
              {issues.filter((i) => i.severity === 'CRITICAL').length} 问题
            </span>
            <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] text-orange-600">
              {issues.filter((i) => i.severity === 'WARNING').length} 建议
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
              {issues.filter((i) => i.severity === 'INFO').length} 提示
            </span>
          </div>

          {issues.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
              {issues.map((v) => (
                <li key={v.id ?? v.code} className="flex items-start gap-1.5 text-[11px]">
                  <RiskPill severity={v.severity} className="mt-px shrink-0 scale-90" />
                  <span className="text-slate-600">{v.title}</span>
                </li>
              ))}
            </ul>
          )}

          {related.length > 0 && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <div className="text-[11px] font-medium text-slate-700">相关组件</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {related.slice(0, 6).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSelect(c)}
                    className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-200"
                  >
                    {c.ref}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
