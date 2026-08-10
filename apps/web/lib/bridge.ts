'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Measurements, Scenario } from '@app/contracts'

export const BRIDGE_URL =
  process.env.NEXT_PUBLIC_BRIDGE_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:3777'

export interface BridgeStatus {
  connected: boolean
  device: string | null
  serial: string | null
  firmware: string | null
  mock: boolean
  scenario: string | null
  running: boolean
  adapter: string
  detail: string | null
  /** 真实适配器至今未经实机验证，Bridge 会把这个标志一路带到 UI */
  hardwareVerified: boolean
  experimental: boolean
  pairingRequired: boolean
  /** 未配对也能切 mock 场景。仅 CI 与内置 Demo 该开 */
  allowUnpairedDebug: boolean
  paired: boolean
  pairingPending: boolean
  codeExpiresInSeconds: number
}

/**
 * 真实硬件路径是否处于未验证状态。
 *
 * 判定放宽一格：老版本 Bridge 不带 hardwareVerified 字段，此时也按未验证算。
 * 少显示一次警告的代价是有人拿未验证的代码去驱动真板子，宁可多显示。
 */
export function isExperimentalHardware(s: BridgeStatus | null): boolean {
  if (!s || s.mock) return false
  return s.experimental === true || s.hardwareVerified !== true
}

/**
 * 配对被显式放宽了。
 *
 * 只放行 mock 场景切换，不放行 /awg —— 但换场景会改变波形、测量值和 AI 诊断
 * 结论，属于「能改变操作者所见」的接口。生产环境不该常开着，所以要显形。
 */
export function isUnpairedDebugOpen(s: BridgeStatus | null): boolean {
  return s?.allowUnpairedDebug === true
}

const TOKEN_KEY = 'bdc.bridge.token'

/** token 存 localStorage：Bridge 是本机服务，token 不该跟着云端账号走 */
export const bridgeToken = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export function bridgeHeaders(): Record<string, string> {
  const t = bridgeToken.get()
  return t ? { authorization: `Bearer ${t}` } : {}
}

export interface PairingApi {
  start: () => Promise<{ expiresInSeconds: number }>
  verify: (code: string) => Promise<string>
  revoke: () => Promise<void>
}

export const bridgePairing: PairingApi = {
  async start() {
    const res = await fetch(`${BRIDGE_URL}/pairing/start`, { method: 'POST' })
    if (!res.ok) throw new Error('无法发起配对，Bridge 可能未运行')
    return res.json()
  },
  async verify(code: string) {
    const res = await fetch(`${BRIDGE_URL}/pairing/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d?.detail?.message ?? '配对失败')
    }
    const { token } = (await res.json()) as { token: string }
    bridgeToken.set(token)
    return token
  },
  async revoke() {
    const token = bridgeToken.get()
    await fetch(`${BRIDGE_URL}/pairing/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => {})
    bridgeToken.clear()
  },
}

export interface AwgRequest {
  channel: 'W1' | 'W2'
  wave: 'sine' | 'square' | 'triangle' | 'sawtooth' | 'dc'
  freqHz: number
  amplitudeVpp: number
  offsetV: number
  confirm?: boolean
}

/** docs/05 §9.4 —— 与 Bridge 侧同一条判据，两边都要拦 */
export const needsConfirm = (a: Pick<AwgRequest, 'amplitudeVpp' | 'offsetV'>) =>
  a.amplitudeVpp > 5 || a.offsetV !== 0

/**
 * 浏览器直连本地 Bridge（CLAUDE.md 硬性原则 #5：云端不碰 USB）。
 * https 前端连 ws://127.0.0.1 在 Chrome/Edge 走 localhost 豁免。
 */
export function useBridge() {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [waveform, setWaveform] = useState<{ ch1: number[]; ch2: number[]; fs: number } | null>(
    null,
  )
  const [measurements, setMeasurements] = useState<Measurements | null>(null)
  const [wsOpen, setWsOpen] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/status`, { cache: 'no-store' })
      setStatus(res.ok ? await res.json() : null)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const t = setInterval(refreshStatus, 5000)
    return () => clearInterval(t)
  }, [refreshStatus])

  useEffect(() => {
    if (!status?.connected) return
    let closed = false

    // 浏览器 WebSocket 握手不能设 header，token 只能走 query
    const token = bridgeToken.get()
    const ws = new WebSocket(
      `${BRIDGE_URL.replace(/^http/, 'ws')}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    )
    wsRef.current = ws
    ws.onopen = () => !closed && setWsOpen(true)
    ws.onclose = () => !closed && setWsOpen(false)
    ws.onerror = () => !closed && setWsOpen(false)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'waveform') {
          setWaveform({ ch1: msg.ch1, ch2: msg.ch2, fs: msg.meta.fs })
        } else if (msg.type === 'measurements') {
          const { ...m } = msg
          setMeasurements(m as Measurements)
        }
      } catch {
        /* 单帧解析失败不影响后续帧 */
      }
    }

    return () => {
      closed = true
      ws.close()
      wsRef.current = null
    }
  }, [status?.connected])

  const applyAwg = useCallback(async (req: AwgRequest) => {
    const res = await fetch(`${BRIDGE_URL}/awg`, {
      method: 'POST',
      // 控制类接口需要配对 token；未配对时 Bridge 回 401
      headers: { 'content-type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify(req),
    })
    if (res.status === 428) {
      const body = await res.json()
      throw Object.assign(new Error('需要二次确认'), { code: 'CONFIRM_REQUIRED', detail: body })
    }
    if (!res.ok) throw new Error(`信号源配置失败: ${res.status}`)
    return res.json()
  }, [])

  const setScenario = useCallback(
    async (scenario: Scenario) => {
      await fetch(`${BRIDGE_URL}/debug/scenario`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bridgeHeaders() },
        body: JSON.stringify({ scenario }),
      })
      await refreshStatus()
    },
    [refreshStatus],
  )

  const setRunning = useCallback(
    async (running: boolean) => {
      await fetch(`${BRIDGE_URL}/scope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bridgeHeaders() },
        body: JSON.stringify({ running, sampleRate: 1_000_000 }),
      })
      await refreshStatus()
    },
    [refreshStatus],
  )

  return {
    status,
    waveform,
    measurements,
    wsOpen,
    applyAwg,
    setScenario,
    setRunning,
    // 配对成功后要立刻重查状态，UI 才能从配对卡切到工作台
    refreshStatus,
  }
}
