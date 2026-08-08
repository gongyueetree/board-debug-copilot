import type { Severity } from '@app/contracts'
import { cn } from './cn'

/** UI 规格见 docs/03：高=红 中=橙 低=蓝灰 正常=绿，圆角小 pill */
const TONES = {
  高风险: 'bg-red-50 text-red-600 ring-red-200',
  中风险: 'bg-orange-50 text-orange-600 ring-orange-200',
  低风险: 'bg-slate-100 text-slate-600 ring-slate-200',
  正常: 'bg-emerald-50 text-emerald-600 ring-emerald-200',
} as const

export type RiskLabel = keyof typeof TONES

const FROM_SEVERITY: Record<Severity, RiskLabel> = {
  CRITICAL: '高风险',
  WARNING: '中风险',
  INFO: '低风险',
}

export function RiskPill({
  label,
  severity,
  className,
}: {
  label?: RiskLabel
  severity?: Severity
  className?: string
}) {
  const resolved: RiskLabel = label ?? (severity ? FROM_SEVERITY[severity] : '低风险')
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[resolved],
        className,
      )}
    >
      {resolved}
    </span>
  )
}
