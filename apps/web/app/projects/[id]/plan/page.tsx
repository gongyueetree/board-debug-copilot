import { PlanClient } from '@/components/plan/PlanClient'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const plan = await prefetch(() => api.plan(id))

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="inline-flex items-center gap-2 text-xl font-semibold text-slate-900">
            调试计划
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-normal text-violet-600">
              AI 生成
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            步骤按证据链排序，异常分支直接指向下一步该测哪里
          </p>
        </div>
      </header>
      <PlanClient projectId={id} initial={plan} />
    </div>
  )
}
