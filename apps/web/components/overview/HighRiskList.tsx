import { RiskPill, SectionCard } from '@app/ui'
import Link from 'next/link'
import type { DesignBundle } from '@/lib/api'

const ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const

/** 高风险问题列表（docs/03 页面 1）：编号圆标 + 风险 pill + 位置 */
export function HighRiskList({
  design,
  projectId,
}: {
  design: DesignBundle
  projectId: string
}) {
  const items = design.violations
    .filter((v) => !v.resolved)
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
    .slice(0, 5)

  return (
    <SectionCard
      title="高风险问题"
      action={
        <Link href={`/projects/${projectId}/design`} className="text-xs font-medium text-brand">
          查看全部 →
        </Link>
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-slate-100">
        {items.map((v, i) => (
          <li key={v.id ?? v.code} className="flex gap-3 px-4 py-3">
            <span
              className={
                v.severity === 'CRITICAL'
                  ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-semibold text-white'
                  : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange-400 text-[10px] font-semibold text-white'
              }
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-900">{v.title}</span>
                <RiskPill severity={v.severity} />
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">
                {v.suggestion || v.description}
              </p>
            </div>
            <span className="shrink-0 self-start text-[11px] text-slate-400">
              {v.componentRef ?? v.netName ?? '—'}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
