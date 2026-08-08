'use client'

import { AI_DISCLAIMER, RiskPill, cn } from '@app/ui'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { API_BASE, type DesignBundle } from '@/lib/api'
import type { DesignReview } from '@app/contracts'

async function runReview(projectId: string): Promise<DesignReview> {
  const res = await fetch(`${API_BASE}/api/v1/ai/design-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!res.ok) throw new Error(`审查失败: ${res.status}`)
  return res.json()
}

const ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const

/** 右栏：AI 设计审查面板（docs/03 页面 2）—— 风险卡片流 + BOM/ERC 小结卡 */
export function ReviewPanel({
  design,
  projectId,
  onFocus,
}: {
  design: DesignBundle
  projectId: string
  onFocus: (ref: string) => void
}) {
  const [review, setReview] = useState<DesignReview | null>(null)
  const mutation = useMutation({ mutationFn: () => runReview(projectId), onSuccess: setReview })

  const findings = (review?.findings ?? design.violations)
    .filter((v) => !v.resolved)
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

  const bom = review?.bomRisk ?? design.bomRisk
  const erc = review?.ercDrc ?? design.ercDrc

  return (
    <aside className="flex w-[360px] shrink-0 flex-col gap-3 overflow-auto">
      <div className="rounded-card border border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
          <h2 className="text-sm font-semibold">AI 设计审查</h2>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-brand disabled:opacity-50"
          >
            {mutation.isPending ? '分析中…' : review ? '重新生成' : '运行审查'}
          </button>
        </header>

        {review?.summary && (
          <p className="border-b border-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
            {review.summary}
          </p>
        )}

        <div className="space-y-2 p-3">
          {findings.map((v) => (
            <article
              key={v.id ?? `${v.code}-${v.componentRef}`}
              className={cn(
                'rounded-lg border p-2.5',
                v.severity === 'CRITICAL'
                  ? 'border-red-100 bg-red-50/40'
                  : v.severity === 'WARNING'
                    ? 'border-orange-100 bg-orange-50/40'
                    : 'border-slate-200',
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-900">{v.title}</span>
                <RiskPill severity={v.severity} />
                {v.componentRef && (
                  <button
                    type="button"
                    onClick={() => onFocus(v.componentRef!)}
                    className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:text-brand"
                  >
                    {v.componentRef}
                  </button>
                )}
              </div>

              <ul className="mt-1.5 space-y-0.5">
                {v.evidence.slice(0, 3).map((e) => (
                  <li key={e} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-600">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>

              {v.risk && (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  <span className="text-slate-400">影响：</span>
                  {v.risk}
                </p>
              )}
              {v.recommendedTest && (
                <p className="mt-1 rounded bg-white px-1.5 py-1 text-[10px] text-slate-500 ring-1 ring-slate-200">
                  建议测量：{v.recommendedTest}
                </p>
              )}
            </article>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-card border border-slate-200 bg-white p-3">
          <div className="text-xs font-semibold">BOM 风险概览</div>
          <dl className="mt-2 space-y-1 text-[11px]">
            <Row label="高风险" value={bom.high} dot="bg-red-500" />
            <Row label="中风险" value={bom.medium} dot="bg-orange-400" />
            <Row label="低风险" value={bom.low} dot="bg-slate-400" />
            <Row label="总计" value={bom.total} />
          </dl>
        </div>
        <div className="rounded-card border border-slate-200 bg-white p-3">
          <div className="text-xs font-semibold">ERC/DRC 总览</div>
          <dl className="mt-2 space-y-1 text-[11px]">
            <Row label="ERC 错误" value={erc.errors} dot="bg-red-500" />
            <Row label="ERC 警告" value={erc.warnings} dot="bg-orange-400" />
            <Row label="DRC 违规" value={erc.violations} dot="bg-red-500" />
          </dl>
        </div>
      </div>

      <p className="px-1 pb-2 text-[10px] text-slate-400">{AI_DISCLAIMER}</p>
    </aside>
  )
}

function Row({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />}
      <dt className="flex-1 text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  )
}
