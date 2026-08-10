'use client'

import { SectionCard, cn } from '@app/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { API_BASE, queryKeys } from '@/lib/api'
import { fileToBase64 } from '@/lib/mutations'

interface KicadStatus {
  status: string
  designVersion: number
  queueAvailable: boolean
  uploads: {
    id: string
    filename: string
    sizeBytes: number | null
    parseStatus: string | null
    parseLog: string | null
    createdAt: string
  }[]
  artifacts: { id: string; kind: string; filename: string; sizeBytes: number | null }[]
}

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  CREATED: { text: '未上传', tone: 'bg-slate-100 text-slate-600' },
  UPLOADED: { text: '已上传', tone: 'bg-blue-50 text-brand' },
  PARSING: { text: '解析中', tone: 'bg-amber-50 text-amber-700' },
  PENDING: { text: '排队中', tone: 'bg-amber-50 text-amber-700' },
  READY: { text: '就绪', tone: 'bg-emerald-50 text-emerald-700' },
  ERROR: { text: '解析失败', tone: 'bg-red-50 text-red-700' },
  OK: { text: '就绪', tone: 'bg-emerald-50 text-emerald-700' },
}

/**
 * parseLog 是给人看的，不是 stack trace。
 * 把最有信息量的那一行翻成用户能行动的说明。
 */
function explainLog(log: string | null): { summary: string; hint: string | null } | null {
  if (!log) return null
  if (log.includes('未找到 kicad-cli')) {
    return {
      summary: '未安装 KiCad CLI，已降级解析',
      hint: '网表已解析，但 ERC/DRC 检查与原理图导出被跳过。安装 KiCad 9 并确保 kicad-cli 在 PATH 中可获得完整结果。',
    }
  }
  if (log.includes('未找到 .kicad_sch')) {
    return {
      summary: '压缩包里没有 KiCad 工程文件',
      hint: '请确认 zip 内包含 .kicad_sch 或 .kicad_pcb，且不是把整个文件夹再套一层压缩。',
    }
  }
  if (log.includes('zip bomb')) {
    return { summary: '压缩包解出体积异常', hint: '解压后总大小超过限制，请检查压缩包是否正常。' }
  }
  if (log.includes('解压失败')) {
    return { summary: '压缩包损坏或不是有效 zip', hint: '请重新打包后再上传。' }
  }
  if (log.includes('未找到，无法提取结构化数据')) {
    return {
      summary: '没有网表，无法提取器件与网络',
      hint: '安装 kicad-cli 可自动导出网表，或在 KiCad 里手动导出 .net 一并打包。',
    }
  }
  if (log.includes('对象存储读不到')) {
    return { summary: '上传的文件读不回来', hint: '对象存储配置可能有误，请检查 STORAGE_ADAPTER 设置。' }
  }
  return null
}

export function KicadUpload({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showLog, setShowLog] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['kicad-status', projectId],
    queryFn: async (): Promise<KicadStatus> => {
      const res = await fetch(`${API_BASE}/api/v1/projects/${projectId}/kicad/status`)
      if (!res.ok) throw new Error('无法获取解析状态')
      return res.json()
    },
    // 解析中时轮询，就绪后停下来
    refetchInterval: (q) =>
      ['PARSING', 'PENDING'].includes((q.state.data as KicadStatus | undefined)?.status ?? '')
        ? 2000
        : false,
  })

  // 显式声明成 Record，否则条件展开会推成不可赋给 HeadersInit 的联合类型
  const authHeaders = (): Record<string, string> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('bdc.token') : null
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  /**
   * 上传：能直传就直传，直传不可用才回落 base64。
   *
   * base64 会把整个文件读进内存再变成 1.33 倍大的字符串发给 API，100MB 的 zip
   * 走这条路会让浏览器和 Node 两端内存都翻倍。所以默认走
   * presign → PUT 到对象存储 → complete 登记，API 全程不碰文件内容。
   *
   * mock 存储没有真正的直传能力（presign 返回 isFallback=true），那时才回落。
   */
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const presign = await fetch(`${API_BASE}/api/v1/projects/${projectId}/kicad/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || 'application/zip',
          // 后端拿这个数去签 content-length，所以必须是浏览器看到的真实大小
          sizeBytes: file.size,
        }),
      })
      const pre = await presign.json()
      if (!presign.ok) throw new Error(pre.message ?? `预签名失败（${presign.status}）`)

      if (!pre.isFallback) {
        const put = await fetch(pre.url, {
          method: 'PUT',
          // 只带 presign 给的头。content-length 由浏览器按 body 自己算 ——
          // 手动设会被忽略（fetch 的禁止头），签名反而对不上。
          headers: pre.headers,
          // 原始 File 作为 body：不 base64、不 ArrayBuffer 中转，
          // 大文件走流式，浏览器内存不会翻倍
          body: file,
        })
        if (!put.ok) {
          throw new Error(
            `直传对象存储失败（${put.status}）。若是 403 SignatureDoesNotMatch，` +
              `多半是 content-length 签名兼容问题，见 docs/09 §6`,
          )
        }

        const done = await fetch(`${API_BASE}/api/v1/projects/${projectId}/kicad/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            objectKey: pre.objectKey,
            filename: file.name,
            sizeBytes: file.size,
          }),
        })
        const body = await done.json()
        if (!done.ok) throw new Error(body.message ?? `登记失败（${done.status}）`)
        return body as { status: string; degraded: boolean; message: string }
      }

      const res = await fetch(`${API_BASE}/api/v1/projects/${projectId}/kicad/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ filename: file.name, base64: await fileToBase64(file) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message ?? `上传失败（${res.status}）`)
      return body as { status: string; degraded: boolean; message: string }
    },
    onSuccess: (r) => {
      setToast(r.message)
      qc.invalidateQueries({ queryKey: ['kicad-status', projectId] })
      qc.invalidateQueries({ queryKey: queryKeys.design(projectId) })
      qc.invalidateQueries({ queryKey: queryKeys.project(projectId) })
    },
    onError: (e) => setToast((e as Error).message),
  })

  const reparse = useMutation({
    mutationFn: async (fileId: string) => {
      const res = await fetch(`${API_BASE}/api/v1/projects/${projectId}/kicad/reparse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ fileId }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message ?? '重新解析失败')
      return body
    },
    onSuccess: () => {
      setToast('已重新解析')
      qc.invalidateQueries({ queryKey: ['kicad-status', projectId] })
      qc.invalidateQueries({ queryKey: queryKeys.design(projectId) })
    },
    onError: (e) => setToast((e as Error).message),
  })

  const latest = data?.uploads[0]
  const explained = explainLog(latest?.parseLog ?? null)
  const badge = STATUS_LABEL[data?.status ?? 'CREATED'] ?? STATUS_LABEL.CREATED!

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          KiCad 工程
          <span className={cn('rounded-full px-2 py-0.5 text-[10px]', badge.tone)}>
            {badge.text}
          </span>
          {data && (
            <span className="text-[10px] font-normal text-slate-400">
              设计版本 v{data.designVersion}
            </span>
          )}
        </span>
      }
      action={
        !readOnly && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            className="rounded bg-blue-50 px-2 py-1 text-[11px] font-medium text-brand disabled:opacity-50"
          >
            {upload.isPending ? '上传中…' : '上传 zip'}
          </button>
        )
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload.mutate(f)
          e.target.value = ''
        }}
      />

      {readOnly && (
        <p className="mb-2 text-[11px] text-slate-400">公共 Demo 只读，复制到自己项目后可上传工程。</p>
      )}

      {data && !data.queueAvailable && (
        <p className="mb-2 rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
          未配置 Redis，解析在请求内同步执行。大工程建议配置队列。
        </p>
      )}

      {latest ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="truncate font-medium text-slate-800">{latest.filename}</span>
            <span className="shrink-0 text-slate-400">
              {latest.sizeBytes ? `${(latest.sizeBytes / 1024).toFixed(0)} KB` : ''}
            </span>
            <span
              className={cn(
                'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px]',
                (STATUS_LABEL[latest.parseStatus ?? ''] ?? STATUS_LABEL.PENDING!).tone,
              )}
            >
              {(STATUS_LABEL[latest.parseStatus ?? ''] ?? STATUS_LABEL.PENDING!).text}
            </span>
          </div>

          {explained && (
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
              <p className="text-[11px] font-medium text-amber-900">{explained.summary}</p>
              {explained.hint && (
                <p className="mt-0.5 text-[10px] leading-relaxed text-amber-800">{explained.hint}</p>
              )}
            </div>
          )}

          <div className="flex gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setShowLog(showLog ? null : (latest.parseLog ?? '（无日志）'))}
              className="text-brand hover:underline"
            >
              {showLog ? '收起解析日志' : '查看解析日志'}
            </button>
            {!readOnly && (
              <button
                type="button"
                onClick={() => reparse.mutate(latest.id)}
                disabled={reparse.isPending}
                className="text-slate-500 hover:underline disabled:opacity-40"
              >
                {reparse.isPending ? '解析中…' : '重新解析'}
              </button>
            )}
          </div>

          {showLog && (
            <pre className="max-h-48 overflow-auto rounded bg-slate-900 p-2 text-[10px] leading-relaxed text-slate-200">
              {showLog}
            </pre>
          )}

          {data && data.artifacts.length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-slate-700">产物</div>
              <ul className="mt-1 space-y-0.5">
                {data.artifacts.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-[11px]">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                      {a.kind}
                    </span>
                    <a
                      href={`${API_BASE}/api/v1/projects/${projectId}/kicad/artifacts/${a.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-brand hover:underline"
                    >
                      {a.filename}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-400">
          尚未上传 KiCad 工程。当前展示的是内置 Demo 数据。
        </p>
      )}

      {toast && <p className="mt-2 text-[11px] text-slate-600">{toast}</p>}
    </SectionCard>
  )
}
