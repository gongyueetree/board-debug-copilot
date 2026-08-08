import { DesignClient } from '@/components/design/DesignClient'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const design = await prefetch(() => api.design(id))

  return (
    <div className="mx-auto max-w-[1800px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">设计审查</h1>
        <p className="mt-1 text-sm text-slate-500">
          规则引擎先于 AI 执行：确定性发现来自网表推导，AI 负责解释成因与排序
        </p>
      </header>
      <DesignClient projectId={id} initial={design} />
    </div>
  )
}
