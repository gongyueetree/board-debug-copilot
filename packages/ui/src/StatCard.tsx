import type { ReactNode } from 'react'
import { cn } from './cn'

export type StatTone = 'green' | 'orange' | 'blue' | 'violet'

const ICON_TONES: Record<StatTone, string> = {
  green: 'bg-emerald-50 text-emerald-600',
  orange: 'bg-orange-50 text-orange-600',
  blue: 'bg-blue-50 text-blue-600',
  violet: 'bg-violet-50 text-violet-600',
}

const PILL_TONES: Record<StatTone, string> = {
  green: 'bg-emerald-50 text-emerald-600',
  orange: 'bg-orange-50 text-orange-600',
  blue: 'bg-blue-50 text-blue-600',
  violet: 'bg-violet-50 text-violet-600',
}

/** 总览页顶部统计卡（docs/03 页面 1） */
export function StatCard({
  icon,
  tone,
  label,
  value,
  sub,
  pill,
  variant = 'number',
  className,
}: {
  icon: ReactNode
  tone: StatTone
  label: string
  value: ReactNode
  sub?: ReactNode
  pill?: string
  /** number 用大字号显示计数；text 用于描述性内容，避免被截断 */
  variant?: 'number' | 'text'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-card border border-slate-200 bg-white p-4',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          ICON_TONES[tone],
        )}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-slate-500">{label}</div>
        <div
          className={cn(
            'mt-0.5 font-semibold text-slate-900',
            variant === 'number' ? 'truncate text-xl' : 'text-sm leading-snug',
          )}
        >
          {value}
        </div>
        {sub && <div className="mt-1 truncate text-xs text-slate-500">{sub}</div>}
      </div>
      {pill && (
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
            PILL_TONES[tone],
          )}
        >
          {pill}
        </span>
      )}
    </div>
  )
}
