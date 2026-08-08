'use client'

import { SectionCard, cn } from '@app/ui'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api, queryKeys, type Report } from '@/lib/api'
import { useGenerateReport } from '@/lib/mutations'

/** 极简 Markdown 渲染器：标题 / 表格 / 列表 / 段落。报告只用到这几种。 */
function renderMarkdown(md: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const lines = md.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (!line.trim()) {
      i++
      continue
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]!.length
      const text = h[2]!
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1] ?? 'h4'
      const size =
        level === 1
          ? 'text-xl font-bold mt-0 mb-3'
          : level === 2
            ? 'text-base font-semibold mt-5 mb-2'
            : 'text-sm font-semibold mt-4 mb-1.5'
      out.push(
        <Tag key={key++} id={text.replace(/\s+/g, '-')} className={cn('text-slate-900', size)}>
          {text}
        </Tag>,
      )
      i++
      continue
    }

    if (line.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells)
        i++
      }
      out.push(
        <table key={key++} className="my-3 w-full border-collapse text-[11px]">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-slate-200">
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      'border border-slate-200 px-2 py-1.5',
                      ci === 0 && 'bg-slate-50 font-medium text-slate-700',
                    )}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    if (/^\d+\.\s/.test(line) || line.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && (/^\d+\.\s/.test(lines[i]!) || lines[i]!.startsWith('- '))) {
        items.push(lines[i]!.replace(/^(\d+\.|-)\s*/, ''))
        i++
      }
      out.push(
        <ol key={key++} className="my-2 list-decimal space-y-0.5 pl-5 text-[11px] text-slate-700">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>,
      )
      continue
    }

    out.push(
      <p key={key++} className="my-1.5 text-[11px] leading-relaxed text-slate-700">
        {line}
      </p>,
    )
    i++
  }
  return out
}

export function ReportClient({
  projectId,
  initial,
}: {
  projectId: string
  initial: Report | null
}) {
  const { data } = useQuery({
    queryKey: queryKeys.report(projectId),
    queryFn: () => api.latestReport(projectId),
    initialData: initial ?? undefined,
  })

  const [view, setView] = useState<'page' | 'outline'>('page')
  const [zoom, setZoom] = useState(100)
  const [note, setNote] = useState<string | null>(null)
  const generate = useGenerateReport(projectId)
  const body = useMemo(() => (data ? renderMarkdown(data.markdown) : []), [data])

  if (!data) {
    return (
      <div className="rounded-card border border-slate-200 bg-white p-6 text-sm text-slate-500">
        暂无报告
      </div>
    )
  }

  const download = () => {
    const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.title}-${data.version}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex gap-4">
      <aside className="w-[240px] shrink-0">
        <SectionCard title="报告目录" bodyClassName="p-2">
          <ul className="space-y-0.5">
            {data.toc.map((t) => (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  className={cn(
                    'block rounded px-2 py-1 text-[11px] hover:bg-slate-50',
                    t.level === 1 ? 'font-medium text-slate-700' : 'pl-5 text-slate-500',
                  )}
                >
                  {t.title}
                </a>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 w-full rounded-lg border border-dashed border-slate-300 py-1.5 text-[11px] text-slate-500 hover:bg-slate-50"
          >
            + 添加自定义章节
          </button>
        </SectionCard>
      </aside>

      <section className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2 rounded-card border border-slate-200 bg-white px-3 py-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
            {(
              [
                ['page', '页面视图'],
                ['outline', '大纲视图'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setView(k)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs',
                  view === k ? 'bg-white font-medium text-brand shadow-sm' : 'text-slate-500',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(60, z - 10))}
            className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            −
          </button>
          <span className="text-xs text-slate-500">{zoom}%</span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(140, z + 10))}
            className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            +
          </button>
          <button
            type="button"
            disabled={generate.isPending}
            onClick={() =>
              generate.mutate(undefined, {
                onSuccess: (r) => setNote(`已生成 ${r.version}`),
                onError: (e) => setNote(e.message),
              })
            }
            className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {generate.isPending ? '生成中…' : '重新生成报告'}
          </button>
          <button
            type="button"
            onClick={download}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
          >
            下载 Markdown
          </button>
          {note && <span className="text-[11px] text-slate-500">{note}</span>}
        </div>

        <div className="overflow-auto rounded-card border border-slate-200 bg-slate-100 p-6">
          {view === 'page' ? (
            <article
              className="mx-auto origin-top bg-white p-10 shadow-sm"
              style={{ width: 794, transform: `scale(${zoom / 100})` }}
            >
              <div className="mb-4 border-b border-slate-200 pb-3">
                <h1 className="text-xl font-bold text-slate-900">{data.title}</h1>
                <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-slate-500">
                  <span>版本：{data.version}</span>
                  <span>作者：{data.author}</span>
                  <span>日期：{new Date(data.createdAt).toLocaleDateString('zh-CN')}</span>
                  <span>工具：Board Debug Copilot</span>
                </div>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                {(
                  [
                    ['问题总数', data.stats.issues, 'bg-red-50 text-red-600'],
                    ['已解决', data.stats.resolved, 'bg-emerald-50 text-emerald-600'],
                    ['优化建议', data.stats.improvements, 'bg-blue-50 text-blue-600'],
                    ['测量项', data.stats.measurements, 'bg-slate-100 text-slate-600'],
                    ['AI 建议', data.stats.aiSuggestions, 'bg-violet-50 text-violet-600'],
                  ] as const
                ).map(([label, value, tone]) => (
                  <span
                    key={label}
                    className={cn('rounded-lg px-3 py-1.5 text-center text-[10px]', tone)}
                  >
                    <span className="block text-base font-semibold">{value}</span>
                    {label}
                  </span>
                ))}
              </div>

              {body}
            </article>
          ) : (
            <div className="mx-auto max-w-2xl rounded-lg bg-white p-6">
              <h2 className="text-sm font-semibold">大纲</h2>
              <ul className="mt-2 space-y-1">
                {data.toc.map((t) => (
                  <li
                    key={t.id}
                    className={cn('text-xs', t.level === 1 ? 'font-medium' : 'pl-5 text-slate-500')}
                  >
                    {t.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <aside className="w-[300px] shrink-0 space-y-3">
        <SectionCard title="报告设置" bodyClassName="p-3">
          <div className="space-y-2 text-[11px]">
            <Field label="报告标题" value={data.title} />
            <Field label="作者" value={data.author ?? ''} />
            <Field label="版本" value={data.version} />
            <Field label="日期" value={new Date(data.createdAt).toLocaleDateString('zh-CN')} />
          </div>
        </SectionCard>

        <SectionCard title="导出选项" bodyClassName="p-2">
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                onClick={download}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[11px] hover:bg-slate-50"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded bg-slate-100 text-slate-600">
                  MD
                </span>
                <span className="flex-1">
                  <span className="block font-medium text-slate-700">导出 Markdown</span>
                  <span className="block text-slate-400">生成 .md 格式文件</span>
                </span>
                <span className="text-brand">→</span>
              </button>
            </li>
            {['PDF', 'DOCX'].map((f) => (
              <li key={f}>
                <div className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[11px] opacity-50">
                  <span className="flex h-7 w-7 items-center justify-center rounded bg-slate-100 text-slate-500">
                    {f === 'PDF' ? 'PDF' : 'W'}
                  </span>
                  <span className="flex-1">
                    <span className="block font-medium text-slate-600">导出 {f}</span>
                    <span className="block text-slate-400">即将支持</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="AI 报告摘要" bodyClassName="p-3">
          <p className="text-[11px] leading-relaxed text-slate-600">
            本次调试共发现 {data.stats.issues} 个问题，其中 {data.stats.resolved}{' '}
            个已定位并提出修复建议。根因由设计上下文、测量数据与视觉检测三路证据交叉印证得出，
            详情参见第 5 章 AI 诊断。
          </p>
          <p className="mt-2 text-[10px] text-slate-400">
            由 AI 生成，内容仅供参考，请结合实际验证。
          </p>
        </SectionCard>
      </aside>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-slate-500">{label}</span>
      <input
        defaultValue={value}
        className="w-full rounded border border-slate-200 px-2 py-1 text-slate-700"
      />
    </label>
  )
}
