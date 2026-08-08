'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, queryKeys, type Component, type DesignBundle } from '@/lib/api'
import { ComponentTree } from './ComponentTree'
import { ReviewPanel } from './ReviewPanel'
import { SchematicViewer } from './SchematicViewer'

export function DesignClient({
  projectId,
  initial,
}: {
  projectId: string
  initial: DesignBundle | null
}) {
  const [selected, setSelected] = useState<Component | null>(null)

  const { data } = useQuery({
    queryKey: queryKeys.design(projectId),
    queryFn: () => api.design(projectId),
    initialData: initial ?? undefined,
  })

  if (!data) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        无法加载设计数据，请确认 api 已启动。
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] gap-4">
      <ComponentTree design={data} selected={selected} onSelect={setSelected} />
      <SchematicViewer design={data} selected={selected} onSelect={setSelected} />
      <ReviewPanel
        design={data}
        projectId={projectId}
        onFocus={(ref) => setSelected(data.components.find((c) => c.ref === ref) ?? null)}
      />
    </div>
  )
}
