import { LabSightAgentWorkspace } from '@/components/labsight/LabSightAgentWorkspace'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function LabSightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [project, design, photos, captures, diagnosis, activity] = await Promise.all([
    prefetch(() => api.project(id)),
    prefetch(() => api.design(id)),
    prefetch(() => api.photos(id)),
    prefetch(() => api.captures(id)),
    prefetch(() => api.diagnosis(id)),
    prefetch(() => api.activity(id)),
  ])

  return (
    <div className="mx-auto max-w-[1800px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>项目</span><span>›</span><span>{project?.name ?? id}</span><span>›</span><span>LabSight 调试</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">LabSight 调试</h1>
          <p className="mt-1 text-sm text-slate-500">
            把现场视觉、KiCad 设计、测量证据与 AI 诊断绑定到同一个 ezPLM 项目上下文
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
          A6 · LabSight Debug Agent · 建议 → 人确认 → 写库
        </div>
      </header>

      <LabSightAgentWorkspace
        projectId={id}
        project={project}
        design={design}
        photos={photos}
        captures={captures}
        diagnosis={diagnosis}
        activity={activity}
      />
    </div>
  )
}
