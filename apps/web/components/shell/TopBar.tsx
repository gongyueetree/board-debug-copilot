'use client'

import { cn } from '@app/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '@/lib/api'

/**
 * 顶栏 — docs/03「全局 Shell」
 * Logo | 项目切换 | 设备状态 | 全局 AI 搜索（Ctrl+K）| 文档 | 通知 | 头像
 *
 * 设备状态在 P4 接 Bridge /status，现在固定灰点未连接。
 * Ctrl+K 目前聚焦搜索框，P3 换成命令面板。
 */
export function TopBar({
  projects,
  currentId,
}: {
  projects: ProjectSummary[]
  currentId: string
}) {
  const router = useRouter()
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const current = projects.find((p) => p.id === currentId) ?? projects[0]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape') {
        setMenuOpen(false)
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 bg-topbar px-4 text-slate-100">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold">
          BD
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Board Debug Copilot</div>
          <div className="text-[10px] text-slate-400">准 LabSight</div>
        </div>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15"
        >
          <span className="max-w-[200px] truncate">{current?.name ?? '选择项目'}</span>
          <svg viewBox="0 0 12 12" className="h-3 w-3 opacity-60" fill="currentColor">
            <path d="M2 4l4 4 4-4z" />
          </svg>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0" onClick={() => setMenuOpen(false)} aria-hidden />
            <ul className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-slate-700 shadow-lg">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      router.push(`/projects/${p.id}`)
                    }}
                    className={cn(
                      'block w-full px-3 py-2 text-left text-sm hover:bg-slate-50',
                      p.id === currentId && 'bg-blue-50 font-medium text-brand',
                    )}
                  >
                    <span className="block truncate">{p.name}</span>
                    {p.currentIssue && (
                      <span className="block truncate text-[11px] text-slate-400">
                        {p.currentIssue}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div
        className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm"
        title="P4 接入 Bridge /status 后联动"
      >
        <span className="h-2 w-2 rounded-full bg-slate-500" />
        <span className="text-slate-300">ADALM2000 未连接</span>
      </div>

      <div className="ml-auto hidden min-w-[260px] max-w-md flex-1 items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 md:flex">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-slate-400" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M7 2a5 5 0 103.1 8.9l3 3 1.4-1.4-3-3A5 5 0 007 2zM4 7a3 3 0 116 0 3 3 0 01-6 0z"
            clipRule="evenodd"
          />
        </svg>
        <input
          ref={searchRef}
          placeholder="问 AI 助手（按 Ctrl + K）"
          className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none"
        />
      </div>

      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold">
        ZH
      </div>
    </header>
  )
}
