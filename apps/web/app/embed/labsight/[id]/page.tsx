import { LabSightAgentWorkspace } from '@/components/labsight/LabSightAgentWorkspace'
import { LabSightClosedLoopPanel } from '@/components/labsight/LabSightClosedLoopPanel'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

/**
 * Shell-free route for ezPLM project tabs / iframe mounting.
 * The ezPLM host owns project navigation, permissions and final write confirmation;
 * this page renders A6, its project-scoped debug loop, and emits labsight:* host actions.
 */
export default async function EmbeddedLabSightPage({ params }: { params: Promise<{ id: string }> }) {
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
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900">
      <div className="mx-auto max-w-[1800px]">
        <LabSightClosedLoopPanel
          projectId={id}
          project={project}
          design={design}
          photos={photos}
          captures={captures}
          diagnosis={diagnosis}
        />
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
    </main>
  )
}
