'use client'

import { AI_DISCLAIMER, RiskPill, SectionCard, cn } from '@app/ui'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api, queryKeys, type BoardPhoto } from '@/lib/api'
import {
  useAnalyzePhoto,
  useCreateAnnotation,
  useDeleteAnnotation,
  useUploadPhoto,
} from '@/lib/mutations'
import { PhotoViewer } from './PhotoViewer'

const QUICK_ASKS = [
  '这块板有没有明显的焊接问题？',
  'U1 的 1 脚在哪里？',
  'R1 和 R2 之间是不是桥接了？',
]

export function PhotosClient({
  projectId,
  initial,
}: {
  projectId: string
  initial: BoardPhoto[] | null
}) {
  const { data } = useQuery({
    queryKey: queryKeys.photos(projectId),
    queryFn: () => api.photos(projectId),
    initialData: initial ?? undefined,
  })

  const [activeId, setActiveId] = useState<string | null>(null)
  const [photoIdx, setPhotoIdx] = useState(0)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const photo = data?.[photoIdx] ?? data?.[0]
  const upload = useUploadPhoto(projectId)
  const createAnnotation = useCreateAnnotation(projectId, photo?.id ?? '')
  const deleteAnnotation = useDeleteAnnotation(projectId)
  const analyze = useAnalyzePhoto(projectId)
  if (!photo) {
    return (
      <div className="rounded-card border border-slate-200 bg-white p-6 text-sm text-slate-500">
        暂无照片
      </div>
    )
  }

  const alignment = photo.alignment as {
    status?: string
    boardOutline?: { matched: number; total: number; corners: { name: string; errorMm: number }[] }
    referencePoints?: { matched: number; total: number; items: string[] }
    componentMapping?: { matchedPct: number; matched: number; total: number; pending: number; unknown: number }
  } | null

  const ask = (q: string) => {
    setQuestion(q)
    const f = photo.findings[0]
    setAnswer(
      f
        ? `基于当前照片的视觉检测：${f.title}（置信度 ${Math.round(f.confidence * 100)}%，${f.certainty === 'CONFIRMED' ? '确定' : '疑似'}）。${f.detail}`
        : '当前照片没有检出可疑区域。',
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="PCB 实物照片"
          action={
            <div className="flex items-center gap-2 text-[11px]">
              {(data?.length ?? 0) > 1 && (
                <select
                  value={photoIdx}
                  onChange={(e) => setPhotoIdx(Number(e.target.value))}
                  className="rounded border border-slate-200 px-1.5 py-0.5"
                >
                  {data?.map((p, i) => (
                    <option key={p.id} value={i}>
                      照片 {i + 1}（{p.side}）
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={upload.isPending}
                className="rounded bg-blue-50 px-2 py-1 font-medium text-brand disabled:opacity-50"
              >
                {upload.isPending ? '上传中…' : '上传照片'}
              </button>
              <button
                type="button"
                onClick={() =>
                  analyze.mutate(photo.id, {
                    onSuccess: (r) => setToast(`重新检测完成，${r.findings.length} 条结果`),
                    onError: (e) => setToast(`检测失败：${e.message}`),
                  })
                }
                disabled={analyze.isPending}
                className="rounded bg-slate-100 px-2 py-1 text-slate-600 disabled:opacity-50"
              >
                {analyze.isPending ? '检测中…' : '重新检测'}
              </button>
            </div>
          }
          bodyClassName="p-3"
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              upload.mutate(f, {
                onSuccess: (r) =>
                  setToast(`已上传 ${f.name}（${(r.sizeBytes / 1024).toFixed(0)} KB）`),
                // 类型/大小校验在服务端，错误信息直接透给用户
                onError: (err) => setToast(err.message),
              })
              e.target.value = ''
            }}
          />
          <PhotoViewer
            photo={photo}
            activeId={activeId}
            onActivate={setActiveId}
            onCreate={(region) =>
              createAnnotation.mutate(
                { kind: 'question', region, note: '待确认区域' },
                {
                  onSuccess: (r) => {
                    setActiveId(r.id)
                    setToast('标注已保存')
                  },
                  onError: (err) => setToast(`标注保存失败：${err.message}`),
                },
              )
            }
          />
          {toast && (
            <p className="mt-2 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">{toast}</p>
          )}
        </SectionCard>

        <SectionCard
          title="KiCad 设计视图（与实物对齐）"
          action={<span className="text-[11px] text-slate-400">P5 占位，对齐数据来自 seed</span>}
          bodyClassName="p-3"
        >
          <div className="aspect-square w-full overflow-hidden rounded-lg bg-slate-900 p-4">
            <svg viewBox="0 0 280 280" className="h-full w-full" role="img" aria-label="KiCad 设计视图">
              <rect x="6" y="6" width="268" height="268" rx="6" fill="#0f172a" stroke="#334155" />
              {[
                [20, 20],
                [260, 20],
                [20, 260],
                [260, 260],
              ].map(([cx, cy]) => (
                <circle key={`${cx}`} cx={cx} cy={cy} r="5" fill="none" stroke="#38bdf8" />
              ))}
              <g fill="none" stroke="#38bdf8" strokeWidth="0.8" opacity="0.8">
                <rect x="118" y="74" width="44" height="30" />
                <rect x="196" y="142" width="26" height="18" />
                <rect x="52" y="194" width="24" height="16" />
                <rect x="136" y="54" width="14" height="7" />
                <rect x="154" y="54" width="14" height="7" />
                <rect x="14" y="74" width="22" height="30" stroke="#eab308" />
                <rect x="244" y="74" width="22" height="30" stroke="#eab308" />
              </g>
              <g fontSize="7" fill="#64748b" fontFamily="ui-monospace, monospace">
                <text x="140" y="92">U1</text>
                <text x="209" y="153">U2</text>
                <text x="64" y="204">U3</text>
                <text x="140" y="50">R1 R2</text>
              </g>
            </svg>
          </div>
        </SectionCard>
      </div>

      {alignment && (
        <SectionCard
          title={
            <span className="inline-flex items-center gap-2">
              对齐与映射状态
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-600">
                {alignment.status}
              </span>
            </span>
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-xs font-medium">
                板框对齐（{alignment.boardOutline?.matched}/{alignment.boardOutline?.total}）
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px]">
                {alignment.boardOutline?.corners.map((c) => (
                  <li key={c.name} className="flex items-center gap-2">
                    <span className="text-emerald-500">✓</span>
                    <span className="flex-1 text-slate-600">{c.name}</span>
                    <span className="text-slate-400">误差 {c.errorMm}mm</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium">
                参考点（{alignment.referencePoints?.matched}/{alignment.referencePoints?.total}）
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px]">
                {alignment.referencePoints?.items.map((it) => (
                  <li key={it} className="flex items-center gap-2">
                    <span className="text-emerald-500">✓</span>
                    <span className="flex-1 text-slate-600">{it}</span>
                    <span className="text-emerald-600">已匹配</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium">
                元器件映射（{alignment.componentMapping?.matchedPct}%）
              </div>
              <dl className="mt-1.5 space-y-1 text-[11px]">
                <Row label="已匹配" value={`${alignment.componentMapping?.matched} / ${alignment.componentMapping?.total}`} />
                <Row label="待确认" value={String(alignment.componentMapping?.pending)} />
                <Row label="未识别" value={String(alignment.componentMapping?.unknown)} />
              </dl>
            </div>
          </div>
        </SectionCard>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="与元器件关联的备注" bodyClassName="p-0">
          <table className="w-full text-[11px]">
            <thead className="border-b border-slate-100 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">关联元件</th>
                <th className="px-3 py-2 font-medium">位置</th>
                <th className="px-3 py-2 font-medium">备注内容</th>
                <th className="px-3 py-2 font-medium">创建人</th>
              </tr>
            </thead>
            <tbody>
              {photo.annotations.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => setActiveId(a.id)}
                  className={cn(
                    'cursor-pointer border-b border-slate-50 hover:bg-slate-50',
                    a.id === activeId && 'bg-blue-50',
                  )}
                >
                  <td className="px-3 py-1.5 font-medium text-slate-700">
                    {a.componentRef ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {(a.region.x * 100).toFixed(0)}%, {(a.region.y * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-1.5 text-slate-600">{a.note}</td>
                  <td className="px-3 py-1.5 text-slate-400">
                    <span className="mr-2">{a.createdBy}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteAnnotation.mutate(a.id)
                      }}
                      className="text-red-500 hover:underline"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[10px] text-slate-400">
            在左侧照片上「框选标注」即可新增一行，直接落库
          </p>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard
            title="AI 视觉检测结果"
            action={
              <span className="text-[11px] text-slate-400">共 {photo.findings.length} 条</span>
            }
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-slate-100">
              {photo.findings.map((f, i) => (
                <li key={f.id} className="flex gap-3 px-3 py-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-semibold text-white">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-slate-900">{f.title}</span>
                      <RiskPill label={f.severity} />
                      <span
                        className={cn(
                          'rounded px-1 py-0.5 text-[9px]',
                          f.certainty === 'CONFIRMED'
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-amber-50 text-amber-600',
                        )}
                      >
                        {f.certainty === 'CONFIRMED' ? '确定' : '疑似'}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{f.detail}</p>
                  </div>
                  <span className="shrink-0 self-start text-[11px] text-slate-400">
                    {Math.round(f.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="向 AI 提问（基于当前 PCB 照片）" bodyClassName="p-3">
            <div className="flex flex-wrap gap-1.5">
              {QUICK_ASKS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => ask(q)}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-200"
                >
                  {q}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && ask(question)}
                placeholder="这颗芯片焊接是否正常？"
                className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() => ask(question)}
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white"
              >
                发送
              </button>
            </div>
            {answer && (
              <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
                {answer}
              </p>
            )}
            <p className="mt-2 text-[10px] text-slate-400">{AI_DISCLAIMER}</p>
          </SectionCard>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex-1 text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  )
}
