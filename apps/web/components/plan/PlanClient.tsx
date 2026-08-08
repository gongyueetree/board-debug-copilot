'use client'

import { SectionCard, cn } from '@app/ui'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, queryKeys, type DebugPlan } from '@/lib/api'
import type { DebugStep } from '@app/contracts'

const STATUS_STYLE = {
  COMPLETED: 'bg-emerald-500',
  IN_PROGRESS: 'bg-blue-500',
  PENDING: 'bg-slate-300',
  FAILED: 'bg-red-500',
  SKIPPED: 'bg-slate-200',
} as const

export function PlanClient({
  projectId,
  initial,
}: {
  projectId: string
  initial: DebugPlan | null
}) {
  const router = useRouter()
  const { data } = useQuery({
    queryKey: queryKeys.plan(projectId),
    queryFn: () => api.plan(projectId),
    initialData: initial ?? undefined,
  })

  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (!data) {
    return (
      <div className="rounded-card border border-slate-200 bg-white p-6 text-sm text-slate-500">
        暂无调试计划
      </div>
    )
  }

  const allSteps = data.groups.flatMap((g) => g.steps)
  // 默认选中 3.1：本次调试的关键证据步骤
  const selected =
    allSteps.find((s) => s.id === selectedId) ??
    allSteps.find((s) => s.number === '3.1') ??
    allSteps[0]

  const isOpen = (id: string) => openGroups.size === 0 || openGroups.has(id)

  const result = (selected?.result ?? null) as {
    measured?: string
    verdict?: string
    note?: string
    expectedValue?: { value: string; unit: string; label: string }
  } | null

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-card border border-orange-200 bg-orange-50 p-4">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">
          0
        </span>
        <div>
          <p className="text-sm font-medium text-slate-900">问题描述：{data.issue}</p>
          <p className="mt-0.5 text-xs text-slate-600">目标：{data.goal}</p>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600">
          {data.completedSteps}/{data.totalSteps} 步完成
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[55fr_45fr]">
        <SectionCard
          title={`调试流程（共 ${data.totalSteps} 步）`}
          action={
            <div className="flex gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setOpenGroups(new Set(data.groups.map((g) => g.id)))}
                className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100"
              >
                全部展开
              </button>
              <button
                type="button"
                onClick={() => setOpenGroups(new Set(['none']))}
                className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100"
              >
                全部折叠
              </button>
            </div>
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-slate-100">
            {data.groups.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenGroups((prev) => {
                      const next = new Set(prev.size === 0 ? data.groups.map((x) => x.id) : prev)
                      if (next.has(g.id)) next.delete(g.id)
                      else next.add(g.id)
                      return next
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                >
                  <span
                    className={cn('h-2.5 w-2.5 rounded-full', STATUS_STYLE[g.status])}
                    aria-hidden
                  />
                  <span className="text-xs font-medium text-slate-800">
                    {g.order} {g.title}
                  </span>
                  <span className="text-[11px] text-slate-400">（{g.steps.length} 步）</span>
                  <span className="ml-auto text-slate-400">{isOpen(g.id) ? '−' : '+'}</span>
                </button>

                {isOpen(g.id) && (
                  <ul>
                    {g.steps.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(s.id)}
                          className={cn(
                            'flex w-full items-center gap-2 py-1.5 pl-8 pr-3 text-left text-[11px] hover:bg-slate-50',
                            s.id === selected?.id && 'bg-blue-50',
                          )}
                        >
                          <span
                            className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLE[s.status])}
                            aria-hidden
                          />
                          <span className="w-8 shrink-0 text-slate-400">{s.number}</span>
                          <span className="flex-1 truncate text-slate-700">{s.title}</span>
                          <span className="w-20 shrink-0 text-right text-slate-400">
                            {s.toolHint}
                          </span>
                          <span className="w-12 shrink-0 text-right text-slate-400">
                            {s.estimateMin} 分钟
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>

        {selected && (
          <StepDetail
            step={selected}
            result={result}
            onStartMeasure={() => {
              // 携带 setupJson 跳转工作台（P6 验收项）
              const q = new URLSearchParams({ step: selected.id })
              if (selected.setup?.mode) q.set('mode', selected.setup.mode)
              router.push(`/projects/${projectId}/bench?${q.toString()}`)
            }}
          />
        )}
      </div>
    </div>
  )
}

function StepDetail({
  step,
  result,
  onStartMeasure,
}: {
  step: DebugStep
  result: {
    measured?: string
    verdict?: string
    note?: string
    expectedValue?: { value: string; unit: string; label: string }
  } | null
  onStartMeasure: () => void
}) {
  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          步骤详情：{step.number} {step.title}
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] text-violet-600">
            AI 推荐
          </span>
        </span>
      }
      action={<span className="font-mono text-[10px] text-slate-400">STP-{step.number}</span>}
      bodyClassName="p-4"
    >
      <div className="grid gap-4 md:grid-cols-[1fr_150px]">
        <div className="space-y-3 text-[11px]">
          <Block title="操作目标">{step.objective}</Block>

          {step.setup && (
            <Block title={`连接与设置（${step.toolHint}）`}>
              <ol className="space-y-0.5">
                <li>1. 模式：{step.setup.mode}</li>
                {step.setup.wiring.map((w, i) => (
                  <li key={`${w.from}-${w.to}`}>
                    {i + 2}. {w.from} → {w.to}
                  </li>
                ))}
                {step.setup.range && <li>量程：{step.setup.range}</li>}
                {step.setup.trigger && <li>触发：{step.setup.trigger}</li>}
              </ol>
              {step.setup.requiresConfirm && (
                <p className="mt-1 rounded bg-orange-50 px-1.5 py-1 text-orange-700">
                  该设置需要二次确认后才会下发
                </p>
              )}
              {step.setup.safetyNotes.map((n) => (
                <p key={n} className="mt-1 text-slate-500">
                  ⚠ {n}
                </p>
              ))}
            </Block>
          )}

          <Block title="目标网点 / 器件">
            {step.targetNet && <div>网点：{step.targetNet}</div>}
            {step.targetComponent && <div>器件：{step.targetComponent}</div>}
            {!step.targetNet && !step.targetComponent && <span className="text-slate-400">—</span>}
          </Block>

          <Block title="预期结果">{step.expectedResult}</Block>

          <Block title="异常情况与下一步">
            <ul className="space-y-1">
              {step.abnormalNext.map((a) => (
                <li key={a} className="flex gap-1.5">
                  <span className="text-orange-500">→</span>
                  <span className="text-slate-600">{a}</span>
                </li>
              ))}
            </ul>
          </Block>
        </div>

        <div className="space-y-3">
          {result?.expectedValue && (
            <div className="rounded-lg border border-slate-200 p-3 text-center">
              <div className="text-[10px] text-slate-400">预期参考值</div>
              <div className="mt-1 text-2xl font-semibold text-emerald-600">
                {result.expectedValue.value}
                <span className="ml-0.5 text-sm">{result.expectedValue.unit}</span>
              </div>
              <div className="text-[10px] text-slate-400">{result.expectedValue.label}</div>
            </div>
          )}

          {result?.measured && (
            <div
              className={cn(
                'rounded-lg border p-3 text-center',
                result.verdict === '异常'
                  ? 'border-red-200 bg-red-50'
                  : 'border-emerald-200 bg-emerald-50',
              )}
            >
              <div className="text-[10px] text-slate-500">实测值</div>
              <div
                className={cn(
                  'mt-1 text-xl font-semibold',
                  result.verdict === '异常' ? 'text-red-600' : 'text-emerald-700',
                )}
              >
                {result.measured}
              </div>
              <div className="text-[10px] font-medium">{result.verdict}</div>
              {result.note && <p className="mt-1 text-[10px] text-slate-600">{result.note}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={onStartMeasure}
          className="flex-1 rounded-lg bg-brand py-2 text-xs font-medium text-white hover:bg-brand-hover"
        >
          开始测量
        </button>
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
        >
          标记完成
        </button>
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
        >
          创建调试记录
        </button>
      </div>
    </SectionCard>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-medium text-slate-900">{title}</div>
      <div className="text-slate-600">{children}</div>
    </div>
  )
}
