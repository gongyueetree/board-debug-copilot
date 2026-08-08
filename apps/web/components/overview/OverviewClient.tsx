'use client'

import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '@/lib/api'
import type {
  ActivityItem,
  AiDiagnosis,
  BoardPhoto,
  CaptureSummary,
  DesignBundle,
  ProjectDetail,
} from '@/lib/api'
import { ActivityTimeline } from './ActivityTimeline'
import { AiCopilotCard } from './AiCopilotCard'
import { DesignOverviewCard } from './DesignOverviewCard'
import { HighRiskList } from './HighRiskList'
import { PhotoCard } from './PhotoCard'
import { RecentWaveformCard } from './RecentWaveformCard'
import { StatRow } from './StatRow'

export interface OverviewData {
  project: ProjectDetail | null
  design: DesignBundle | null
  captures: CaptureSummary[] | null
  activity: ActivityItem[] | null
  diagnosis: AiDiagnosis | null
  photos: BoardPhoto[] | null
}

/**
 * 服务端已预取一轮作为 initialData，首屏直接是内容；
 * 客户端由 TanStack Query 接管后续刷新。
 */
export function OverviewClient({
  projectId,
  initial,
}: {
  projectId: string
  initial: OverviewData
}) {
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.project(projectId),
    initialData: initial.project ?? undefined,
  })
  const design = useQuery({
    queryKey: queryKeys.design(projectId),
    queryFn: () => api.design(projectId),
    initialData: initial.design ?? undefined,
  })
  const captures = useQuery({
    queryKey: queryKeys.captures(projectId),
    queryFn: () => api.captures(projectId),
    initialData: initial.captures ?? undefined,
  })
  const activity = useQuery({
    queryKey: queryKeys.activity(projectId),
    queryFn: () => api.activity(projectId),
    initialData: initial.activity ?? undefined,
  })
  const diagnosis = useQuery({
    queryKey: queryKeys.diagnosis(projectId),
    queryFn: () => api.diagnosis(projectId),
    initialData: initial.diagnosis ?? undefined,
    retry: false,
  })
  const photos = useQuery({
    queryKey: queryKeys.photos(projectId),
    queryFn: () => api.photos(projectId),
    initialData: initial.photos ?? undefined,
  })

  if (project.isError && !project.data) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        <p className="font-medium">无法连接后端 API</p>
        <p className="mt-1 text-xs">
          请确认 api 已启动，且 <code>NEXT_PUBLIC_API_BASE_URL</code> 指向正确地址。
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {project.data ? <StatRow project={project.data} /> : <SkeletonRow />}

      <div className="grid gap-4 xl:grid-cols-3">
        {design.data ? (
          <DesignOverviewCard design={design.data} projectId={projectId} />
        ) : (
          <SkeletonCard />
        )}
        {captures.data ? (
          <RecentWaveformCard captures={captures.data} projectId={projectId} />
        ) : (
          <SkeletonCard />
        )}
        <AiCopilotCard diagnosis={diagnosis.data ?? null} projectId={projectId} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {design.data ? <HighRiskList design={design.data} projectId={projectId} /> : <SkeletonCard />}
        {activity.data ? (
          <ActivityTimeline activity={activity.data} projectId={projectId} />
        ) : (
          <SkeletonCard />
        )}
        {photos.data ? <PhotoCard photos={photos.data} projectId={projectId} /> : <SkeletonCard />}
      </div>
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[86px] animate-pulse rounded-card border border-slate-200 bg-white" />
      ))}
    </div>
  )
}

function SkeletonCard() {
  return <div className="h-[320px] animate-pulse rounded-card border border-slate-200 bg-white" />
}
