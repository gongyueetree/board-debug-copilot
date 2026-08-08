import { ReportClient } from '@/components/report/ReportClient'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const report = await prefetch(() => api.latestReport(id))

  return (
    <div className="mx-auto max-w-[1800px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">测试报告</h1>
        <p className="mt-1 text-sm text-slate-500">由已落库的事实聚合生成，不新增结论</p>
      </header>
      <ReportClient projectId={id} initial={report} />
    </div>
  )
}
