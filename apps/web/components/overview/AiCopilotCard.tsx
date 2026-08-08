import { AI_DISCLAIMER, RiskPill, SectionCard } from '@app/ui'
import Link from 'next/link'
import type { AiDiagnosis } from '@/lib/api'

/** AI 调试参谋卡（docs/03 页面 1）：可能问题 / 关键证据 / 推荐下一步 */
export function AiCopilotCard({
  diagnosis,
  projectId,
}: {
  diagnosis: AiDiagnosis | null
  projectId: string
}) {
  if (!diagnosis) {
    return (
      <SectionCard title="AI 调试参谋">
        <p className="py-8 text-center text-xs text-slate-400">暂无诊断，先在调试工作台采集一次波形</p>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          AI 调试参谋
          <RiskPill severity={diagnosis.severity} />
        </span>
      }
      action={
        <span className="text-[11px] text-slate-400">
          置信度 {Math.round(diagnosis.confidence * 100)}%
        </span>
      }
      bodyClassName="flex flex-col gap-3 p-4"
    >
      <div>
        <div className="text-xs font-medium text-slate-900">可能问题</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{diagnosis.rootCause}</p>
        {diagnosis.alternativeCauses.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {diagnosis.alternativeCauses.map((a) => (
              <li key={a.cause} className="text-[11px] text-slate-400">
                备选：{a.cause}（{Math.round(a.likelihood * 100)}%）
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-slate-900">关键证据</div>
        <ul className="mt-1 space-y-1">
          {diagnosis.evidence.map((e) => (
            <li key={e} className="flex gap-1.5 text-xs leading-relaxed text-slate-600">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
              <span>{e}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="text-xs font-medium text-slate-900">推荐下一步</div>
        <ol className="mt-1 space-y-1.5">
          {diagnosis.recommendations.map((r) => (
            <li key={r.order} className="flex gap-2 text-xs leading-relaxed">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[10px] font-medium text-brand">
                {r.order}
              </span>
              <span className="text-slate-600">
                <span className="text-slate-800">{r.action}</span>
                {r.detail && <span className="block text-slate-400">{r.detail}</span>}
                {r.instrumentPreset && (
                  <span className="mt-0.5 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {r.instrumentPreset.mode}
                    {r.instrumentPreset.requiresConfirm ? ' · 需二次确认' : ''}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-auto flex gap-2 pt-1">
        <Link
          href={`/projects/${projectId}/plan`}
          className="flex-1 rounded-lg bg-brand px-3 py-2 text-center text-xs font-medium text-white hover:bg-brand-hover"
        >
          生成调试步骤
        </Link>
        <Link
          href={`/projects/${projectId}/bench`}
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          打开工作台
        </Link>
      </div>
      <p className="text-[10px] text-slate-400">{AI_DISCLAIMER}</p>
    </SectionCard>
  )
}
