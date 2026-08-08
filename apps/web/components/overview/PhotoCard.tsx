'use client'

import { RiskPill, SectionCard, cn } from '@app/ui'
import Link from 'next/link'
import { useState } from 'react'
import { BoardPhotoPlaceholder } from '@/components/photo/BoardPhotoPlaceholder'
import type { BoardPhoto } from '@/lib/api'

/** PCB 实物照片卡（docs/03 页面 1）：高亮框 + 说明 + 轮播圆点 */
export function PhotoCard({ photos, projectId }: { photos: BoardPhoto[]; projectId: string }) {
  const photo = photos[0]
  const findings = photo?.findings ?? []
  const [idx, setIdx] = useState(0)
  const current = findings[idx]

  if (!photo) {
    return (
      <SectionCard title="PCB 实物照片">
        <p className="py-8 text-center text-xs text-slate-400">暂无照片</p>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="PCB 实物照片"
      action={
        <Link href={`/projects/${projectId}/photos`} className="text-xs font-medium text-brand">
          查看全部 →
        </Link>
      }
      bodyClassName="p-3"
    >
      <BoardPhotoPlaceholder
        highlight={current?.componentRef ?? null}
        className="h-[168px] w-full rounded-lg"
      />

      {current && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-900">{current.title}</span>
            <RiskPill label={current.severity} />
            <span className="ml-auto text-[11px] text-slate-400">
              置信度 {Math.round(current.confidence * 100)}%
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">
            {current.detail}
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center justify-center gap-1.5">
        {findings.map((f, i) => (
          <button
            key={f.id}
            type="button"
            aria-label={f.title}
            onClick={() => setIdx(i)}
            className={cn(
              'h-1.5 rounded-full transition-all',
              i === idx ? 'w-4 bg-brand' : 'w-1.5 bg-slate-300 hover:bg-slate-400',
            )}
          />
        ))}
      </div>
    </SectionCard>
  )
}
