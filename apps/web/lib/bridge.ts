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
  scenario: string
  running: boolean
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

    const ws = new WebSocket(`${BRIDGE_URL.replace(/^http/, 'ws')}/ws`)
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
          const { type, ...m } = msg
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
      headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ running, sampleRate: 1_000_000 }),
      })
      await refreshStatus()
    },
    [refreshStatus],
  )

  return { status, waveform, measurements, wsOpen, applyAwg, setScenario, setRunning }
}
