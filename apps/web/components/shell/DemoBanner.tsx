'use client'

import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { API_BASE } from '@/lib/api'

/**
 * 公共 Demo 只读提示。
 *
 * 早先匿名也能写公共 Demo，演示方便但任何访客都能污染所有人看到的数据。
 * 现在改成只读 + 一键克隆。
 */
export function DemoBanner({ projectId, isDemo }: { projectId: string; isDemo: boolean }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [needLogin, setNeedLogin] = useState(false)

  const clone = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem('bdc.token')
      const res = await fetch(`${API_BASE}/api/v1/projects/${projectId}/clone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.message ?? '克隆失败')
      return body as { id: string; name: string }
    },
    onSuccess: (p) => router.push(`/projects/${p.id}`),
    onError: () => setNeedLogin(true),
  })

  const login = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) throw new Error('登录失败')
      const { token } = (await res.json()) as { token: string }
      localStorage.setItem('bdc.token', token)
    },
    onSuccess: () => {
      setNeedLogin(false)
      clone.mutate()
    },
  })

  if (!isDemo) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-amber-200 bg-amber-50 px-4 py-2.5">
      <span className="text-xs text-amber-900">
        这是公共 Demo，<strong>只读</strong>。复制一份到自己名下即可修改、上传工程和保存测量。
      </span>

      {needLogin ? (
        <div className="ml-auto flex gap-1.5">
          <input
            autoFocus
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && login.mutate()}
            placeholder="邮箱即账号，无需密码"
            className="w-56 rounded border border-amber-300 px-2 py-1 text-xs focus:outline-none"
          />
          <button
            type="button"
            disabled={!email.includes('@') || login.isPending}
            onClick={() => login.mutate()}
            className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {login.isPending ? '…' : '登录并复制'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={clone.isPending}
          onClick={() => clone.mutate()}
          className="ml-auto rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {clone.isPending ? '复制中…' : '复制到我的项目'}
        </button>
      )}
    </div>
  )
}
