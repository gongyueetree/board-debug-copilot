'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { CameraCapturePanel } from '@/components/photo/CameraCapturePanel'
import { PhotosClient } from '@/components/photo/PhotosClient'
import {
  API_BASE,
  type ActivityItem,
  type AiDiagnosis,
  type BoardPhoto,
  type CaptureSummary,
  type DesignBundle,
  type ProjectDetail,
} from '@/lib/api'

type Mode = 'live' | 'compare'
type AgentState = 'checking' | 'online' | 'offline'

type InvokeResponse = {
  ok?: boolean
  narration?: string
  result?: unknown
  tools?: unknown[]
  cards?: unknown[]
}

const QUICK_ASKS = [
  '基于当前项目证据，最值得先验证的问题是什么？',
  '下一步应该测哪个节点？请说明原因。',
  '根据最近的照片和测量，列出最可能的故障假设。',
  '当前证据是否足够形成一个可复现的 Issue？',
]

function ago(ts?: string | null) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function shortText(value: unknown, fallback = '—') {
  if (typeof value === 'string' && value.trim()) return value
  return fallback
}

function latestEvidence(photos: BoardPhoto[], captures: CaptureSummary[], activity: ActivityItem[]) {
  const photoRows = photos.slice(0, 3).map((p) => ({
    id: `photo:${p.id}`,
    kind: '照片',
    title: p.findings[0]?.componentRef
      ? `${p.findings[0].componentRef} · ${p.findings[0].title}`
      : p.findings[0]?.title || `PCB ${p.side || '照片'}`,
    detail: p.findings[0]?.detail || `${p.annotations.length} 条标注`,
    time: p.createdAt,
    tone: p.findings.some((f) => f.certainty === 'CONFIRMED') ? 'amber' : 'blue',
  }))
  const captureRows = captures.slice(0, 3).map((c) => ({
    id: `capture:${c.id}`,
    kind: c.kind,
    title: c.netName ? `${c.netName} · ${c.kind}` : c.label || c.kind,
    detail: c.scenario || '测量证据',
    time: c.createdAt,
    tone: 'purple',
  }))
  const activityRows = activity.slice(0, 2).map((a) => ({
    id: `activity:${a.id}`,
    kind: '记录',
    title: a.title,
    detail: a.detail,
    time: a.timestamp,
    tone: 'slate',
  }))
  return [...photoRows, ...captureRows, ...activityRows]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 5)
}

export function LabSightAgentWorkspace({
  projectId,
  project,
  design,
  photos,
  captures,
  diagnosis,
  activity,
}: {
  projectId: string
  project: ProjectDetail | null
  design: DesignBundle | null
  photos: BoardPhoto[] | null
  captures: CaptureSummary[] | null
  diagnosis: AiDiagnosis | null
  activity: ActivityItem[] | null
}) {
  const [mode, setMode] = useState<Mode>('live')
  const [agentState, setAgentState] = useState<AgentState>('checking')
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [alignmentBusy, setAlignmentBusy] = useState(false)

  const safePhotos = photos ?? []
  const safeCaptures = captures ?? []
  const safeActivity = activity ?? []
  const evidence = useMemo(
    () => latestEvidence(safePhotos, safeCaptures, safeActivity),
    [safePhotos, safeCaptures, safeActivity],
  )
  const currentPhoto = safePhotos[0]
  const latestCapture = safeCaptures[0]

  useEffect(() => {
    let disposed = false
    fetch(`${API_BASE}/api/v1/ai/labsight-agent/manifest`, { headers: { accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(() => !disposed && setAgentState('online'))
      .catch(() => !disposed && setAgentState('offline'))

    try {
      window.parent?.postMessage(
        { source: 'ezplm-labsight', type: 'labsight:ready', agent: 'A6', projectId },
        '*',
      )
    } catch {}
    return () => {
      disposed = true
    }
  }, [projectId])

  const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await fetch(`${API_BASE}/api/v1/ai/labsight-agent/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ projectId, action, ...extra }),
    })
    const data = (await r.json().catch(() => ({}))) as InvokeResponse & { message?: string }
    if (!r.ok) throw new Error(data.message || `LabSight Agent HTTP ${r.status}`)
    return data
  }

  const ask = async (text = question) => {
    const q = text.trim()
    if (!q || busy) return
    setQuestion('')
    setMessages((prev) => [...prev, { role: 'user', text: q }])
    setBusy(true)
    try {
      const data = await invoke('chat', { question: q })
      let answer = data.narration?.trim() || ''
      if (!answer && data.result) {
        answer = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)
      }
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', text: answer || 'LabSight 已完成分析，但当前结果没有可显示的文本。' },
      ])
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', text: `调用失败：${(e as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  const alignLatest = async () => {
    if (!currentPhoto || alignmentBusy) {
      setNotice('当前项目还没有可用于配准的 PCB 照片。')
      return
    }
    setAlignmentBusy(true)
    setNotice(null)
    try {
      await invoke('assembly_align', { photoId: currentPhoto.id })
      setNotice('已完成 KiCad ↔ 实物 PCB 配准。刷新照片/对比区域可查看最新映射。')
    } catch (e) {
      setNotice(`同步定位失败：${(e as Error).message}`)
    } finally {
      setAlignmentBusy(false)
    }
  }

  const hostDraft = (action: 'create_issue_draft' | 'create_eco_draft') => {
    const label = action === 'create_issue_draft' ? 'Issue' : 'ECO'
    try {
      window.parent?.postMessage(
        {
          source: 'ezplm-labsight',
          type: 'labsight:host-action',
          action,
          projectId,
          context: {
            diagnosis: diagnosis?.rootCause ?? null,
            latestPhotoId: currentPhoto?.id ?? null,
            latestCaptureId: latestCapture?.id ?? null,
          },
        },
        '*',
      )
    } catch {}
    setNotice(`已生成 ${label} 草稿请求。LabSight 不会自动落库，需由 ezPLM 宿主显示 diff 并由工程师确认。`)
  }

  const projectBase = `/projects/${projectId}`
  const rootCause = diagnosis?.rootCause || project?.currentIssue || '尚未形成故障结论'
  const evidenceCount = safePhotos.length + safeCaptures.length + safeActivity.length

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-5 py-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-blue-600 text-xl font-semibold text-white shadow-sm">AI</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">LabSight 调试 Agent</h2>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  A6 · {agentState === 'online' ? 'Agent API Online' : agentState === 'checking' ? '检查中…' : 'API Offline'}
                </span>
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700">Project Context 已绑定</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                画面 + KiCad + BOM/元件 + 测量 + 调试记录使用同一个项目上下文；声网实时语音后续直接复用同一 A6 调用入口。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">证据 {evidenceCount}</span>
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">设计 v{project?.designVersion ?? '—'}</span>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex rounded-lg bg-slate-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode('live')}
            className={`rounded-md px-4 py-1.5 font-medium ${mode === 'live' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}
          >
            实时调试
          </button>
          <button
            type="button"
            onClick={() => setMode('compare')}
            className={`rounded-md px-4 py-1.5 font-medium ${mode === 'compare' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}
          >
            PCB 对比分析
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void alignLatest()}
            disabled={alignmentBusy || !currentPhoto}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 disabled:opacity-40"
          >
            {alignmentBusy ? '同步定位中…' : '同步定位'}
          </button>
          <Link href={`${projectBase}/design`} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            查看设计上下文
          </Link>
        </div>
      </div>

      {mode === 'live' ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(340px,.72fr)]">
          <div className="min-w-0 space-y-4">
            <CameraCapturePanel projectId={projectId} />
            <EvidenceStrip rows={evidence} />
            <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <Link href={`${projectBase}/bench`} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700">记录测量</Link>
              <button type="button" onClick={() => void ask('请根据当前项目的最新照片、测量和设计上下文做一次简洁的故障分析。')} className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-xs font-medium text-violet-700">AI 分析</button>
              <button type="button" onClick={() => hostDraft('create_issue_draft')} className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-700">创建 Issue 草稿</button>
              <button type="button" onClick={() => hostDraft('create_eco_draft')} className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-700">生成 ECO 草稿</button>
              <span className="ml-auto self-center text-[10px] text-slate-400">草稿动作必须由 ezPLM 宿主人工确认后才能写库</span>
            </div>
          </div>
          <aside className="space-y-4">
            <EngineeringContextCard
              projectId={projectId}
              project={project}
              design={design}
              latestCapture={latestCapture}
              diagnosis={diagnosis}
            />
            <AgentChat
              question={question}
              setQuestion={setQuestion}
              messages={messages}
              busy={busy}
              ask={ask}
            />
          </aside>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.65fr)]">
          <div className="min-w-0">
            {safePhotos.length ? (
              <PhotosClient projectId={projectId} initial={safePhotos} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
                还没有 PCB 照片。先切到“实时调试”连接摄像头并抓取一张高清帧，再进行 KiCad 对比分析。
              </div>
            )}
          </div>
          <aside className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-semibold text-slate-900">AI 对比摘要</div>
              <div className="mt-3 rounded-lg border border-red-100 bg-red-50 p-3">
                <div className="text-xs font-medium text-red-700">当前问题</div>
                <p className="mt-1 text-xs leading-5 text-red-700">{shortText(project?.currentIssue, rootCause)}</p>
              </div>
              <dl className="mt-3 grid grid-cols-[90px_1fr] gap-x-2 gap-y-2 text-xs">
                <dt className="text-slate-400">关联器件</dt><dd className="text-slate-700">{diagnosis?.recommendations?.[0]?.targetComponent || '—'}</dd>
                <dt className="text-slate-400">关联网络</dt><dd className="text-slate-700">{latestCapture?.netName || diagnosis?.recommendations?.[0]?.targetNet || '—'}</dd>
                <dt className="text-slate-400">证据</dt><dd className="text-slate-700">{diagnosis?.evidence?.length ?? 0} 条诊断证据</dd>
                <dt className="text-slate-400">置信度</dt><dd className="text-slate-700">{diagnosis ? `${Math.round(diagnosis.confidence * 100)}%` : '—'}</dd>
              </dl>
            </div>
            <AgentChat question={question} setQuestion={setQuestion} messages={messages} busy={busy} ask={ask} />
          </aside>
        </div>
      )}

      {notice && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-xl">
          <button type="button" onClick={() => setNotice(null)} className="float-right ml-3 text-slate-400">×</button>
          {notice}
        </div>
      )}
    </div>
  )
}

function EngineeringContextCard({
  projectId,
  project,
  design,
  latestCapture,
  diagnosis,
}: {
  projectId: string
  project: ProjectDetail | null
  design: DesignBundle | null
  latestCapture?: CaptureSummary
  diagnosis: AiDiagnosis | null
}) {
  const base = `/projects/${projectId}`
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">工程上下文</h3>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">实时绑定</span>
      </div>
      <dl className="mt-3 grid grid-cols-[82px_1fr] gap-x-2 gap-y-2 text-xs">
        <dt className="text-slate-400">项目</dt><dd className="truncate font-medium text-slate-700">{project?.name || '—'}</dd>
        <dt className="text-slate-400">设计版本</dt><dd className="text-slate-700">v{project?.designVersion ?? '—'}</dd>
        <dt className="text-slate-400">器件 / 网络</dt><dd className="text-slate-700">{design?.components.length ?? 0} / {design?.nets.length ?? 0}</dd>
        <dt className="text-slate-400">测试点</dt><dd className="text-slate-700">{design?.testPoints.length ?? 0}</dd>
        <dt className="text-slate-400">最近测量</dt><dd className="text-slate-700">{latestCapture ? `${latestCapture.kind}${latestCapture.netName ? ` · ${latestCapture.netName}` : ''}` : '—'}</dd>
        <dt className="text-slate-400">当前判断</dt><dd className="text-slate-700">{diagnosis?.rootCause || project?.currentIssue || '尚无诊断'}</dd>
      </dl>
      <div className="mt-4 grid grid-cols-5 gap-1.5 text-center text-[10px]">
        {[
          ['原理图', `${base}/design`],
          ['PCB / 照片', `${base}/photos`],
          ['测量', `${base}/bench`],
          ['计划', `${base}/plan`],
          ['报告', `${base}/report`],
        ].map(([label, href]) => (
          <Link key={label} href={href} className="rounded-lg bg-slate-50 px-1 py-2 text-slate-600 hover:bg-blue-50 hover:text-blue-700">
            {label}
          </Link>
        ))}
      </div>
    </section>
  )
}

function AgentChat({
  question,
  setQuestion,
  messages,
  busy,
  ask,
}: {
  question: string
  setQuestion: (value: string) => void
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  busy: boolean
  ask: (value?: string) => Promise<void>
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">提问与语音互动</h3>
          <p className="mt-0.5 text-[10px] text-slate-400">A6 使用项目设计、照片、测量、诊断和调试步骤作为同一上下文</p>
        </div>
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-600">Agent</span>
      </div>
      <div className="max-h-[360px] min-h-[180px] space-y-2 overflow-auto bg-slate-50/40 p-3">
        {!messages.length && (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white p-3 text-xs leading-5 text-slate-500">
            可以直接问“下一步测哪里”“这张照片和 KiCad 哪些地方不一致”“最近一次波形说明了什么”。
          </div>
        )}
        {messages.map((m, i) => (
          <div key={`${m.role}-${i}`} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-5 ${m.role === 'user' ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}>
              {m.text}
            </div>
          </div>
        ))}
        {busy && <div className="text-xs text-blue-600">LabSight 正在结合项目证据分析…</div>}
      </div>
      <div className="border-t border-slate-100 p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_ASKS.map((q) => (
            <button key={q} type="button" onClick={() => void ask(q)} className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600 hover:bg-slate-200">
              {q}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask()
              }
            }}
            placeholder="输入问题，例如：为什么 3.3V 只有 2.71V？"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-400"
          />
          <button type="button" disabled={busy || !question.trim()} onClick={() => void ask()} className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40">
            发送
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-400">声网 RTC 会在下一阶段迁到这个同一 A6 Context；当前文本调用已经走统一 Agent 入口。</p>
      </div>
    </section>
  )
}

function EvidenceStrip({ rows }: { rows: Array<{ id: string; kind: string; title: string; detail: string; time: string; tone: string }> }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">最近证据</h3>
        <span className="text-[10px] text-slate-400">照片 / 波形 / 诊断活动统一进入 Evidence Timeline</span>
      </div>
      {rows.length ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {rows.map((r) => (
            <div key={r.id} className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-500">{r.kind}</span>
                <span className="text-[9px] text-slate-400">{ago(r.time)}</span>
              </div>
              <div className="mt-2 truncate text-[11px] font-medium text-slate-700">{r.title}</div>
              <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-400">{r.detail}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">还没有证据。抓一张 PCB 照片或记录一次测量后，这里会自动出现。</div>
      )}
    </section>
  )
}
