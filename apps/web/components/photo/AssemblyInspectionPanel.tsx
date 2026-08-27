'use client'

import { SectionCard, cn } from '@app/ui'
import { useState } from 'react'
import { useAssemblyInspect, type AssemblyInspectionResult } from '@/lib/mutations'

export function AssemblyInspectionPanel({ photoId }: { photoId: string }) {
  const inspect = useAssemblyInspect()
  const [result, setResult] = useState<AssemblyInspectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setError(null)
    inspect.mutate(photoId, {
      onSuccess: setResult,
      onError: (e) => setError(e.message),
    })
  }

  return (
    <SectionCard
      title="KiCad Footprint 装配检查"
      action={
        <button
          type="button"
          onClick={run}
          disabled={inspect.isPending}
          className="rounded bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
        >
          {inspect.isPending ? '正在比对…' : '检查漏装器件'}
        </button>
      }
    >
      <p className="text-[11px] leading-5 text-slate-500">
        直接读取项目 .kicad_pcb 的 footprint 位置、旋转和 pad 分组；同一 footprint 的全部焊盘按一个器件判断。安装孔、测试点和 Pogo 接触焊盘自动排除。
      </p>

      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {result && (
        <div className="mt-3 space-y-3">
          <div className={cn(
            'rounded-lg px-3 py-2 text-sm font-medium',
            result.missing.length ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700',
          )}>
            {result.summary}
          </div>

          {result.missing.length > 0 && (
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
          )}

          {result.uncertain.length > 0 && (
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
          )}

          <div className="text-[10px] text-slate-400">
            已检查 {result.inspected} 个可装配 footprint · 自动排除 {result.excluded} 个非装配对象 · PCB：{result.pcbFile}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
