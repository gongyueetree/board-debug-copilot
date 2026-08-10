import { OverviewClient } from '@/components/overview/OverviewClient'
import { DemoBanner } from '@/components/shell/DemoBanner'
import { loadOverview } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const initial = await loadOverview(id)

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">项目总览</h1>
        {initial.project?.currentIssue && (
          <p className="mt-1 text-sm text-slate-500">
            当前问题：{initial.project.currentIssue}
          </p>
        )}
      </header>
      <DemoBanner projectId={id} isDemo={initial.project?.isDemo ?? false} />
      <OverviewClient projectId={id} initial={initial} />
    </div>
  )
}
