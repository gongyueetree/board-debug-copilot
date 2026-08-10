'use client'

import { SectionCard } from '@app/ui'
import { useState } from 'react'
import { bridgePairing, type BridgeStatus } from '@/lib/bridge'

/**
 * Bridge 配对流程。
 *
 * Origin 校验挡不住本机的非浏览器调用，配对码走的是"用户能看到 Bridge
 * 控制台"这个带外信道 —— 对一个能驱动真实硬件的服务，这才是有意义的凭据。
 */
export function PairingCard({
  status,
  onPaired,
}: {
  status: BridgeStatus | null
  onPaired: () => void
}) {
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'verifying'>('idle')
  const [error, setError] = useState<string | null>(null)

  // Bridge 没跑时不是配对问题，是根本没连上
  if (!status) {
    return (
      <SectionCard title="本地 Bridge">
        <p className="text-xs text-slate-500">
          未检测到本地 Bridge。请先启动：
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-[10px] text-slate-200">
          pnpm bridge:dev
        </pre>
        <p className="mt-2 text-[11px] text-slate-400">
          或运行打包好的 bdc-bridge 可执行程序。Bridge 只监听 127.0.0.1，不接受外部连接。
        </p>
      </SectionCard>
    )
  }

  if (!status.pairingRequired || status.paired) return null

  const start = async () => {
    setError(null)
    try {
      await bridgePairing.start()
      setPhase('waiting')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const verify = async () => {
    setPhase('verifying')
    setError(null)
    try {
      await bridgePairing.verify(code)
      onPaired()
    } catch (e) {
      setError((e as Error).message)
      setPhase('waiting')
    }
  }

  return (
    <SectionCard title="连接本地 Bridge">
      {phase === 'idle' ? (
        <>
          <p className="text-xs text-slate-600">
            Bridge 已运行但尚未配对。点击后请查看 Bridge 控制台窗口显示的 6 位配对码。
          </p>
          <button
            type="button"
            onClick={start}
            className="mt-3 w-full rounded-lg bg-brand py-2 text-xs font-medium text-white hover:bg-brand-hover"
          >
            连接本地 Bridge
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-slate-600">
            请输入 Bridge 控制台显示的 6 位配对码（5 分钟内有效）
          </p>
          <div className="mt-2 flex gap-2">
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && verify()}
              placeholder="000000"
              inputMode="numeric"
              className="flex-1 rounded border border-slate-200 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] focus:border-brand focus:outline-none"
            />
            <button
              type="button"
              disabled={code.length !== 6 || phase === 'verifying'}
              onClick={verify}
              className="rounded-lg bg-brand px-4 text-xs font-medium text-white disabled:opacity-40"
            >
              {phase === 'verifying' ? '验证中…' : '确认'}
            </button>
          </div>
          <button
            type="button"
            onClick={start}
            className="mt-2 text-[11px] text-brand hover:underline"
          >
            没看到？重新生成配对码
          </button>
        </>
      )}
      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </SectionCard>
  )
}
