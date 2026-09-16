import { LabSightAgentWorkspace } from '@/components/labsight/LabSightAgentWorkspace'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

/**
 * Shell-free route for ezPLM project tabs / iframe mounting.
 * The ezPLM host owns project navigation, permissions and final write confirmation;
 * this page only renders the LabSight A6 workspace and emits labsight:* postMessage events.
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
