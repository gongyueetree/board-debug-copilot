'use client'

import { cn } from '@app/ui'
import { useCallback, useRef, useState } from 'react'
import { BoardPhotoPlaceholder } from './BoardPhotoPlaceholder'
import type { BoardPhoto } from '@/lib/api'

interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 照片查看器：缩放/平移/框选标注/编号圆标/图层开关（docs/03 页面 4）。
 *
 * 用原生指针事件而非 Konva —— 标注只有矩形一种，引 Konva 会为一个矩形
 * 拖进一整套 canvas 场景图。归一化坐标与 PhotoAnnotation.regionJson 一致。
 */
export function PhotoViewer({
  photo,
  activeId,
  onActivate,
  onCreate,
}: {
  photo: BoardPhoto
  activeId: string | null
  onActivate: (id: string | null) => void
  onCreate: (region: Region) => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [drawing, setDrawing] = useState<Region | null>(null)
  const [mode, setMode] = useState<'select' | 'annotate'>('select')
  const [layers, setLayers] = useState({ marks: true, numbers: true, nets: false })
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const toNorm = useCallback((e: React.PointerEvent) => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }, [])

  const onDown = (e: React.PointerEvent) => {
    if (mode !== 'annotate') return
    const p = toNorm(e)
    startRef.current = p
    setDrawing({ x: p.x, y: p.y, w: 0, h: 0 })
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (!startRef.current) return
    const p = toNorm(e)
    const s = startRef.current
    setDrawing({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    })
  }

  const onUp = () => {
    if (drawing && drawing.w > 0.01 && drawing.h > 0.01) onCreate(drawing)
    startRef.current = null
    setDrawing(null)
    setMode('select')
  }

  const annotations = photo.annotations

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => setMode(mode === 'annotate' ? 'select' : 'annotate')}
          className={cn(
            'rounded-md px-2 py-1',
            mode === 'annotate' ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600',
          )}
        >
          {mode === 'annotate' ? '框选中…' : '框选标注'}
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          className="rounded-md bg-slate-100 px-2 py-1 text-slate-600"
        >
          −
        </button>
        <span className="w-10 text-center text-slate-500">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          className="rounded-md bg-slate-100 px-2 py-1 text-slate-600"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
          className="rounded-md bg-slate-100 px-2 py-1 text-slate-600"
        >
          复位
        </button>
        <span className="ml-auto rounded bg-emerald-50 px-2 py-0.5 text-emerald-600">✓ 已对齐</span>
      </div>

      <div
        ref={boxRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className={cn(
          'relative aspect-square w-full select-none overflow-hidden rounded-lg',
          mode === 'annotate' ? 'cursor-crosshair' : 'cursor-grab',
        )}
      >
        <div
          className="absolute inset-0 origin-center transition-transform"
          style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)` }}
        >
          <BoardPhotoPlaceholder
            highlight={
              annotations.find((a) => a.id === activeId)?.componentRef ?? null
            }
            className="h-full w-full"
          />
        </div>

        {layers.marks &&
          annotations.map((a, i) => {
            const r = a.region
            const active = a.id === activeId
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onActivate(active ? null : a.id)}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
                className={cn(
                  'absolute rounded border-2',
                  a.kind === 'question'
                    ? 'border-dashed border-orange-400'
                    : 'border-yellow-400',
                  active && 'ring-2 ring-white',
                )}
                title={a.note ?? undefined}
              >
                {layers.numbers && (
                  <span className="absolute -left-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-yellow-400 text-[9px] font-bold text-slate-900">
                    {i + 1}
                  </span>
                )}
              </button>
            )
          })}

        {drawing && (
          <div
            style={{
              left: `${drawing.x * 100}%`,
              top: `${drawing.y * 100}%`,
              width: `${drawing.w * 100}%`,
              height: `${drawing.h * 100}%`,
            }}
            className="absolute border-2 border-brand bg-brand/10"
          />
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-600">
        <span className="text-slate-400">图层</span>
        {(
          [
            ['marks', '标注'],
            ['numbers', '编号'],
            ['nets', '网络高亮'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={layers[k]}
              onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })}
              className="h-3 w-3 accent-blue-600"
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  )
}
