'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  API_BASE,
  type AiDiagnosis,
  type BoardPhoto,
  type CaptureSummary,
  type DesignBundle,
  type ProjectDetail,
} from '@/lib/api'

type DebugSession = {
  id: string
  projectId: string
  boardId?: string | null
  designVersion: number
  title: string
  issue?: string | null
  goal?: string | null
  status: 'OPEN' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'
  rootCauseCode?: string | null
  createdAt: string
  board?: { id: string; label?: string | null; serialNo?: string | null; isGolden: boolean } | null
  _count?: { evidence: number; captures: number; hypotheses: number }
}

type Board = {
  id: string
  label?: string | null
  serialNo?: string | null
  batchNo?: string | null
  isGolden: boolean
  status: string
}

type Evidence = {
  id: string
  kind: string
  ref: string
  excerpt?: string | null
  createdAt: string
}

type NextBestTest = {
  hypothesis: { id: string; statement: string; confidence: number }
  nextTest: {
    id: string
    title: string
    targetNet?: string | null
    targetComponent?: string | null
    toolHint?: string | null
    expectedObservation?: string | null
    score: number
    informationGain: number
    safetyCost: number
    effortCost: number
    why: string
  }
  alternatives: Array<{ id: string; title: string; score: number; why: string }>
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((data as { message?: string }).message || `HTTP ${response.status}`)
  }
  return data as T
}

export function LabSightClosedLoopPanel({
  projectId,
  project,
  design,
  photos,
  captures,
  diagnosis,
}: {
  projectId: string
  project: ProjectDetail | null
  design: DesignBundle | null
  photos: BoardPhoto[] | null
  captures: CaptureSummary[] | null
  diagnosis: AiDiagnosis | null
}) {
  const [sessions, setSessions] = useState<DebugSession[]>([])
  const [boards, setBoards] = useState<Board[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [hypothesis, setHypothesis] = useState('')
  const [nextBest, setNextBest] = useState<NextBestTest | null>(null)
  const [goldenResult, setGoldenResult] = useState<{ changed?: number; compared?: number; differences?: Array<{ ref: string; differenceScore: number; delta?: number | null }> } | null>(null)

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  )
  const currentPhoto = photos?.[0]
  const latestCapture = captures?.[0]
  const goldenBoard = boards.find((board) => board.isGolden)

  const reload = useCallback(async () => {
    const [nextSessions, nextBoards] = await Promise.all([
      jsonFetch<DebugSession[]>(`/projects/${projectId}/debug-sessions`),
      jsonFetch<Board[]>(`/projects/${projectId}/boards`),
    ])
    setSessions(nextSessions)
    setBoards(nextBoards)
    setActiveSessionId((current) => current || nextSessions.find((s) => s.status === 'OPEN')?.id || nextSessions[0]?.id || '')
  }, [projectId])

  useEffect(() => {
    void reload().catch((error) => setMessage(`加载 Debug Session 失败：${(error as Error).message}`))
  }, [reload])

  useEffect(() => {
    if (!activeSession?.id) {
      setEvidence([])
      return
    }
    void jsonFetch<Evidence[]>(`/debug-sessions/${activeSession.id}/evidence`)
      .then(setEvidence)
      .catch((error) => setMessage(`加载 Evidence 失败：${(error as Error).message}`))
  }, [activeSession?.id])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; draftId?: string; externalObjectId?: string; accepted?: boolean }
      if (data?.source !== 'ezplm' || data.type !== 'labsight:host-action-result' || !data.draftId || !data.externalObjectId) return
      void jsonFetch(`/labsight/drafts/${data.draftId}/ack`, {
        method: 'POST',
        body: JSON.stringify({ externalObjectId: data.externalObjectId, accepted: data.accepted ?? true }),
      }).then(() => setMessage(`ezPLM 已回写对象 ${data.externalObjectId}，LabSight 闭环完成。`))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const ensureSession = async () => {
    if (activeSession) return activeSession
    const created = await jsonFetch<DebugSession>(`/projects/${projectId}/debug-sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: '现场调试',
        issue: project?.currentIssue || diagnosis?.rootCause || undefined,
        goal: '基于现场证据定位根因并形成可复现的 Issue / ECO 闭环',
      }),
    })
    await reload()
    setActiveSessionId(created.id)
    return created
  }

  const createSession = async () => {
    setBusy(true)
    try {
      const created = await jsonFetch<DebugSession>(`/projects/${projectId}/debug-sessions`, {
        method: 'POST',
        body: JSON.stringify({
          title: `调试 Session ${sessions.length + 1}`,
          issue: project?.currentIssue || undefined,
          goal: '定位本次实物板问题并保留完整证据链',
        }),
      })
      await reload()
      setActiveSessionId(created.id)
      setMessage('新的 Debug Session 已正式落到项目。')
    } catch (error) {
      setMessage(`创建 Session 失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const syncCurrentEvidence = async (sessionId: string) => {
    const tasks: Array<Promise<unknown>> = []
    if (currentPhoto) {
      tasks.push(jsonFetch(`/debug-sessions/${sessionId}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          kind: 'IMAGE',
          ref: `photo:${currentPhoto.id}`,
          sourceType: 'board_photo',
          sourceId: currentPhoto.id,
          excerpt: currentPhoto.findings?.[0]?.detail || `PCB ${currentPhoto.side || 'photo'}`,
          data: { side: currentPhoto.side, findings: currentPhoto.findings?.slice(0, 5) ?? [] },
        }),
      }))
    }
    if (latestCapture) {
      const net = design?.nets.find((item) => item.name === latestCapture.netName)
      tasks.push(jsonFetch(`/debug-sessions/${sessionId}/captures/${latestCapture.id}/bind`, {
        method: 'POST',
        body: JSON.stringify({
          ref: `capture:${latestCapture.id}${latestCapture.netName ? `/net:${latestCapture.netName}` : ''}`,
          netId: net?.id,
          excerpt: latestCapture.netName ? `${latestCapture.kind} @ ${latestCapture.netName}` : latestCapture.label || latestCapture.kind,
          data: { scenario: latestCapture.scenario, kind: latestCapture.kind },
        }),
      }))
    }
    if (diagnosis) {
      tasks.push(jsonFetch(`/debug-sessions/${sessionId}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          kind: 'DIAGNOSIS',
          ref: `diagnosis:${diagnosis.id}`,
          sourceType: 'ai_diagnosis',
          sourceId: diagnosis.id,
          excerpt: `${diagnosis.rootCause} · confidence ${Math.round(diagnosis.confidence * 100)}%`,
          data: { rootCause: diagnosis.rootCause, confidence: diagnosis.confidence },
        }),
      }))
      const recommendation = diagnosis.recommendations?.[0]
      const ref = recommendation?.targetComponent
      const netName = recommendation?.targetNet
      const component = design?.components.find((item) => item.ref === ref)
      const net = design?.nets.find((item) => item.name === netName)
      if (ref || netName) {
        tasks.push(jsonFetch(`/debug-sessions/${sessionId}/evidence`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'KICAD',
            ref: `kicad:v${project?.designVersion ?? 1}${ref ? `/ref:${ref}` : ''}${netName ? `/net:${netName}` : ''}`,
            sourceType: 'kicad_design_graph',
            componentId: component?.id,
            netId: net?.id,
            excerpt: [ref, netName, recommendation?.action].filter(Boolean).join(' · '),
            data: { targetComponent: ref, targetNet: netName, action: recommendation?.action },
          }),
        }))
      }
    }
    await Promise.all(tasks)
    setEvidence(await jsonFetch<Evidence[]>(`/debug-sessions/${sessionId}/evidence`))
  }

  const draft = async (kind: 'ISSUE' | 'ECO') => {
    setBusy(true)
    try {
      const session = await ensureSession()
      await syncCurrentEvidence(session.id)
      const recommendation = diagnosis?.recommendations?.[0]
      const payload = kind === 'ISSUE'
        ? {
            title: `[LabSight] ${project?.currentIssue || diagnosis?.rootCause || '调试问题'}`,
            symptom: project?.currentIssue || diagnosis?.rootCause || '现场调试发现异常',
            observed: diagnosis?.rootCause || undefined,
            reproduction: ['打开对应 Debug Session', '按 Evidence Timeline 顺序复现测量/观察', '核对关联 Ref/Net/Pin/TestStep'],
            relatedRefs: recommendation?.targetComponent ? [recommendation.targetComponent] : [],
            relatedNets: recommendation?.targetNet ? [recommendation.targetNet] : [],
          }
        : {
            title: `[LabSight ECO] ${diagnosis?.rootCause || project?.currentIssue || '工程变更建议'}`,
            reason: diagnosis?.rootCause || project?.currentIssue || '调试证据支持工程变更',
            proposedChange: recommendation?.action || '根据已确认根因修改设计并走人工 diff 审核',
            affectedRefs: recommendation?.targetComponent ? [recommendation.targetComponent] : [],
            verificationPlan: ['在同一测试点复测', '与 Golden Board 对比', '确认异常证据消失后关闭 Session'],
          }
      const result = await jsonFetch<{ draft: { id: string }; suggestion: unknown; hostAction: Record<string, unknown> }>(`/projects/${projectId}/labsight/drafts/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, payload }),
      })
      window.parent?.postMessage({ ...result.hostAction, suggestion: result.suggestion }, '*')
      setMessage(`${kind} Draft 已由 A6 生成并带证据发送给 ezPLM 宿主；等待人工确认和对象 ID 回写。`)
    } catch (error) {
      setMessage(`${kind} Draft 失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const addHypothesisAndRecommend = async () => {
    const text = hypothesis.trim() || diagnosis?.rootCause || project?.currentIssue || ''
    if (!text) {
      setMessage('先输入一个故障假设，或先让 A6 形成诊断。')
      return
    }
    setBusy(true)
    try {
      const session = await ensureSession()
      await syncCurrentEvidence(session.id)
      await jsonFetch(`/debug-sessions/${session.id}/hypotheses`, {
        method: 'POST',
        body: JSON.stringify({
          statement: text,
          expectedObservation: diagnosis?.recommendations?.[0]?.detail || undefined,
          confidence: diagnosis?.confidence ?? 0.5,
        }),
      })
      const recommendation = await jsonFetch<NextBestTest>(`/debug-sessions/${session.id}/next-best-test`, { method: 'POST' })
      setNextBest(recommendation)
      setHypothesis('')
      setMessage('已按信息增益、安全成本和操作成本选出下一步最值得测的项目。')
      await reload()
    } catch (error) {
      setMessage(`Next Best Test 失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const compareGolden = async () => {
    if (!goldenBoard) {
      setMessage('当前项目还没有标记 Golden Board。先通过 Board API/项目资产登记一块已知良品。')
      return
    }
    setBusy(true)
    try {
      const session = await ensureSession()
      await syncCurrentEvidence(session.id)
      const result = await jsonFetch<typeof goldenResult>(`/projects/${projectId}/labsight/golden-compare`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, goldenBoardId: goldenBoard.id, targetBoardId: session.boardId || undefined }),
      })
      setGoldenResult(result)
      setMessage(`Golden Board 对比完成：${result?.changed ?? 0}/${result?.compared ?? 0} 个同位证据存在明显差异。`)
    } catch (error) {
      setMessage(`Golden Board 对比失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Debug Closed Loop</h2>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">P1 → P3</span>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">Project DB</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Session → Evidence → Hypothesis → Next Best Test → Issue/ECO；所有对象都绑定当前 ezPLM Project。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={activeSession?.id || ''}
            onChange={(event) => setActiveSessionId(event.target.value)}
            className="max-w-[260px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
          >
            {!sessions.length && <option value="">尚无 Debug Session</option>}
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.status}</option>)}
          </select>
          <button type="button" disabled={busy} onClick={() => void createSession()} className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 disabled:opacity-40">+ 新建 Session</button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">P1 · Evidence</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{evidence.length}</div>
          <div className="mt-1 text-[11px] text-slate-500">Ref / Net / Pin / TestStep 可绑定</div>
          <button disabled={busy || !activeSession} onClick={() => activeSession && void syncCurrentEvidence(activeSession.id)} className="mt-3 rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-blue-700 shadow-sm disabled:opacity-40">同步当前证据</button>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">P1 · ezPLM Objects</div>
          <div className="mt-2 flex gap-2">
            <button disabled={busy} onClick={() => void draft('ISSUE')} className="rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-medium text-white disabled:opacity-40">Issue Draft</button>
            <button disabled={busy} onClick={() => void draft('ECO')} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-medium text-slate-700 disabled:opacity-40">ECO Draft</button>
          </div>
          <div className="mt-2 text-[10px] leading-4 text-slate-400">A6 Suggestion → ezPLM native drawer → 人确认 → externalObjectId 回写</div>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">P2 · Golden Board</div>
          <div className="mt-1 text-xs font-medium text-slate-700">{goldenBoard ? (goldenBoard.label || goldenBoard.serialNo || goldenBoard.id) : '尚未登记'}</div>
          <button disabled={busy || !goldenBoard} onClick={() => void compareGolden()} className="mt-3 rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-violet-700 shadow-sm disabled:opacity-40">运行差异排序</button>
          {goldenResult && <div className="mt-2 text-[10px] text-slate-500">changed {goldenResult.changed}/{goldenResult.compared}</div>}
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">P3 · Next Best Test</div>
          <input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} placeholder="输入假设；留空则用当前诊断" className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] outline-none focus:border-blue-400" />
          <button disabled={busy} onClick={() => void addHypothesisAndRecommend()} className="mt-2 rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-medium text-white disabled:opacity-40">推荐下一步</button>
        </div>
      </div>

      {nextBest && (
        <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-medium text-blue-500">A6 建议下一步最值得测</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">{nextBest.nextTest.title}</div>
            </div>
            <div className="rounded-lg bg-white px-3 py-2 text-xs text-blue-700">信息增益 {Math.round(nextBest.nextTest.informationGain * 100)}%</div>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-600">{nextBest.nextTest.why}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500">
            {nextBest.nextTest.targetComponent && <span className="rounded bg-white px-2 py-1">Ref {nextBest.nextTest.targetComponent}</span>}
            {nextBest.nextTest.targetNet && <span className="rounded bg-white px-2 py-1">Net {nextBest.nextTest.targetNet}</span>}
            {nextBest.nextTest.toolHint && <span className="rounded bg-white px-2 py-1">{nextBest.nextTest.toolHint}</span>}
            {nextBest.nextTest.expectedObservation && <span className="rounded bg-white px-2 py-1">期望：{nextBest.nextTest.expectedObservation}</span>}
          </div>
        </div>
      )}

      {goldenResult?.differences?.length ? (
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-100">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-slate-50 text-slate-400"><tr><th className="px-3 py-2">Evidence Ref</th><th className="px-3 py-2">Difference</th><th className="px-3 py-2">Delta</th></tr></thead>
            <tbody>{goldenResult.differences.slice(0, 6).map((item) => <tr key={item.ref} className="border-t border-slate-100"><td className="px-3 py-2 font-mono text-slate-600">{item.ref}</td><td className="px-3 py-2">{item.differenceScore.toFixed(3)}</td><td className="px-3 py-2">{item.delta == null ? '—' : item.delta.toFixed(4)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}

      {message && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">{message}</div>}
    </section>
  )
}
