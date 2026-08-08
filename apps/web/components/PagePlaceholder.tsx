import { RiskPill } from '@app/ui'

/**
 * P0 占位页。每个页面标注它属于哪个 Phase、规格在 docs/03 的哪一节，
 * 后续 Phase 直接替换本组件即可。
 */
export function PagePlaceholder({
  title,
  phase,
  spec,
  points,
}: {
  title: string
  phase: string
  spec: string
  points: string[]
}) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600">
          {phase} 待实现
        </span>
      </div>

      <div className="bdc-card p-5">
        <div className="mb-3 flex items-center gap-2 text-sm text-slate-500">
          <RiskPill label="低风险" />
          <span>UI 规格：{spec}</span>
        </div>
        <ul className="space-y-1.5 text-sm text-slate-700">
          {points.map((p) => (
            <li key={p} className="flex gap-2">
              <span className="text-slate-400">·</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
