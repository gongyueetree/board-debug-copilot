'use client'

import { SectionCard, cn } from '@app/ui'
import Link from 'next/link'
import type { ActivityItem } from '@/lib/api'

const TONE = {
  brand: 'bg-blue-50 text-brand',
  green: 'bg-emerald-50 text-emerald-600',
  slate: 'bg-slate-100 text-slate-500',
} as const

const DOT = {
  capture: 'bg-blue-500',
  step: 'bg-emerald-500',
  diagnosis: 'bg-violet-500',
} as const

function clock(ts: string) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 最近调试记录时间线（docs/03 页面 1） */
export function ActivityTimeline({
  activity,
  projectId,
}: {
  activity: ActivityItem[]
  projectId: string
}) {
  return (
    <SectionCard
      title="最近调试记录"
      action={
        <Link href={`/projects/${projectId}/plan`} className="text-xs font-medium text-brand">
          查看全部 →
        </Link>
      }
      bodyClassName="p-0"
    >
      <ol className="relative px-4 py-3">
        <span className="absolute left-[26px] top-5 bottom-5 w-px bg-slate-200" aria-hidden />
        {activity.slice(0, 6).map((a) => (
          <li key={a.id} className="relative flex gap-3 py-2">
            <span
              className={cn(
                'relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-white',
                DOT[a.kind],
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-[11px] text-slate-400">
                  {clock(a.timestamp)}
                </span>
                <span className="truncate text-xs font-medium text-slate-800">{a.title}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    TONE[a.tone],
                  )}
                >
                  {a.status}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">
                {a.detail}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-slate-100 p-3">
        <Link
          href={`/projects/${projectId}/bench`}
          className="block rounded-lg border border-slate-200 py-2 text-center text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          打开调试工作台
        </Link>
      </div>
    </SectionCard>
  )
}
