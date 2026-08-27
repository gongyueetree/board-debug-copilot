'use client'

import { SectionCard, cn } from '@app/ui'
import { useMemo, useState } from 'react'
import {
  useAssemblyAlign,
  useAssemblyInspect,
  type AssemblyAlignmentResult,
  type AssemblyInspectionResult,
} from '@/lib/mutations'

export function AssemblyInspectionPanel({ photoId }: { photoId: string }) {
  const align = useAssemblyAlign()
  const inspect = useAssemblyInspect()
  const [alignment, setAlignment] = useState<AssemblyAlignmentResult | null>(null)
  const [result, setResult] = useState<AssemblyInspectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = align.isPending || inspect.isPending

  const runAlign = () => {
    setError(null)
    align.mutate({ photoId, force: true }, {
      onSuccess: setAlignment,
      onError: (e) => setError(e.message),
    })
  }

  const run = () => {
    setError(null)
    inspect.mutate(photoId, {
      onSuccess: (r) => {
        setResult(r)
        setAlignment({
          photoId: r.photoId,
          pcbFile: r.pcbFile,
          side: 'front',
          ...r.alignment,
          rois: r.rois,
        })
      },
      onError: (e) => setError(e.message),
    })
  }

  const active = alignment ?? (result ? {
    photoId: result.photoId,
    pcbFile: result.pcbFile,
    side: 'front' as const,
    ...result.alignment,
    rois: result.rois,
  } : null)

  const missing = useMemo(() => new Set(result?.missing.map((x) => x.ref) ?? []), [result])
  const uncertain = useMemo(() => new Set(result?.uncertain.map((x) => x.ref) ?? []), [result])

  return (
    <SectionCard
      title="KiCad ↔ 实物 PCB 自动配准 / Footprint 装配检查"
      action={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={runAlign}
            disabled={busy}
            className="rounded bg-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-700 disabled:opacity-50"
          >
            {align.isPending ? '正在配准…' : '重新配准'}
          </button>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="rounded bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {inspect.isPending ? '配准并检查…' : '检查漏装器件'}
          </button>
        </div>
      }
    >
      <p className="text-[11px] leading-5 text-slate-500">
        先用板框、位号和器件群把 KiCad 坐标透视映射到实物照片，再为每个 footprint 自动生成独立 ROI；漏装判断只在对应 ROI 内进行。安装孔、测试点和 Pogo 接触焊盘自动排除。
      </p>

      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {active && (
        <div className="mt-3 grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-lg border border-slate-200 bg-slate-950 p-2">
            <div className="mb-2 flex items-center gap-2 text-[10px] text-slate-300">
              <span>ROI 配准预览</span>
              <span className={cn(
                'rounded px-1.5 py-0.5',
                active.status === 'aligned' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300',
              )}>
                {active.status === 'aligned' ? '已配准' : active.status === 'low-confidence' ? '低置信' : '不可用'} · {Math.round(active.confidence * 100)}%
              </span>
              <span className="ml-auto">ROI {active.rois.length}</span>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded bg-slate-900">
              {active.corners && (
                <svg viewBox="0 0 1000 750" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                  <polygon
                    points={[
                      active.corners.pcb00,
                      active.corners.pcb10,
                      active.corners.pcb11,
                      active.corners.pcb01,
                    ].map((p) => `${p.x * 1000},${p.y * 750}`).join(' ')}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="5"
                    className="text-cyan-400"
                  />
                </svg>
              )}
              {active.rois.map((roi) => (
                <div
                  key={roi.ref}
                  title={`${roi.ref} ${roi.value}`}
                  style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` }}
                  className={cn(
                    'absolute min-h-[3px] min-w-[3px] border',
                    missing.has(roi.ref) && 'z-20 border-2 border-red-400 bg-red-400/15',
                    uncertain.has(roi.ref) && 'z-10 border-amber-400 bg-amber-400/10',
                    !missing.has(roi.ref) && !uncertain.has(roi.ref) && 'border-cyan-500/50',
                  )}
                >
                  {(missing.has(roi.ref) || uncertain.has(roi.ref)) && (
                    <span className={cn(
                      'absolute -top-4 left-0 rounded px-1 text-[8px] font-semibold',
                      missing.has(roi.ref) ? 'bg-red-500 text-white' : 'bg-amber-400 text-slate-900',
                    )}>{roi.ref}</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px] leading-4 text-slate-400">
              板框来源：{active.boundsSource === 'edge-cuts' ? 'Edge.Cuts' : 'Footprint 范围回退'}
              {active.validationError != null ? ` · Anchor RMS ${active.validationError.toFixed(3)}` : ''}
              {active.anchors.length ? ` · ${active.anchors.length} 个视觉锚点` : ''}
            </div>
          </div>

          <div className="space-y-3">
            {result && (
              <div className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium',
                result.missing.length ? 'bg-red-50 text-red-700' : result.alignment.status === 'aligned' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
              )}>
                {result.summary}
              </div>
            )}

            {result?.missing.length ? (
              <div>
                <div className="mb-1.5 text-xs font-semibold text-slate-800">确认未安装</div>
                <div className="space-y-1.5">
                  {result.missing.map((item) => (
                    <div key={item.ref} className="rounded-lg border border-red-100 bg-white px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-red-700">{item.ref}</span>
                        {item.value && <span className="text-xs text-slate-500">{item.value}</span>}
                        <span className="ml-auto text-[10px] text-slate-400">{Math.round(item.confidence * 100)}%</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-600">{item.evidence}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {result?.uncertain.length ? (
              <div>
                <div className="mb-1.5 text-xs font-semibold text-slate-700">无法确认</div>
                <div className="space-y-1.5">
                  {result.uncertain.map((item) => (
                    <div key={item.ref} className="rounded-lg border border-amber-100 bg-amber-50/40 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-amber-800">{item.ref}</span>
                        {item.value && <span className="text-[11px] text-slate-500">{item.value}</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-600">{item.evidence}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {result && (
              <div className="text-[10px] text-slate-400">
                已检查 {result.inspected} 个 ROI · 自动排除 {result.excluded} 个非装配对象 · PCB：{result.pcbFile}
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
