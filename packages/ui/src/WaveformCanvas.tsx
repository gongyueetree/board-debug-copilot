'use client'

import { useEffect, useRef } from 'react'
import { cn } from './cn'

export interface WaveformTrace {
  /** 归一化到 [-1, 1] 的采样点；由调用方按 V/div 换算 */
  samples: number[]
  color: string
}

/**
 * 时域波形（docs/03 页面 1 / 页面 3）。
 *
 * CLAUDE.md 硬性要求：ResizeObserver + devicePixelRatio 缩放，窗口缩放不得模糊。
 * 不引入图表库 —— 直接 Canvas 绘制。
 */
export function WaveformCanvas({
  traces,
  divisionsX = 10,
  divisionsY = 8,
  className,
  background = '#0b1220',
  grid = '#1e293b',
}: {
  traces: WaveformTrace[]
  divisionsX?: number
  divisionsY?: number
  className?: string
  background?: string
  grid?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const tracesRef = useRef(traces)
  tracesRef.current = traces

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const cssW = parent.clientWidth
      const cssH = parent.clientHeight
      if (cssW === 0 || cssH === 0) return

      // 用 DPR 放大位图，再把绘制坐标系缩回 CSS 像素 —— 高分屏才不会糊
      const pxW = Math.round(cssW * dpr)
      const pxH = Math.round(cssH * dpr)
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW
        canvas.height = pxH
      }
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      ctx.fillStyle = background
      ctx.fillRect(0, 0, cssW, cssH)

      // 网格
      ctx.strokeStyle = grid
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 1; i < divisionsX; i++) {
        const x = Math.round((cssW / divisionsX) * i) + 0.5
        ctx.moveTo(x, 0)
        ctx.lineTo(x, cssH)
      }
      for (let i = 1; i < divisionsY; i++) {
        const y = Math.round((cssH / divisionsY) * i) + 0.5
        ctx.moveTo(0, y)
        ctx.lineTo(cssW, y)
      }
      ctx.stroke()

      // 中线
      ctx.strokeStyle = '#334155'
      ctx.beginPath()
      const midY = Math.round(cssH / 2) + 0.5
      ctx.moveTo(0, midY)
      ctx.lineTo(cssW, midY)
      ctx.stroke()

      // 波形
      for (const trace of tracesRef.current) {
        const n = trace.samples.length
        if (n < 2) continue
        ctx.strokeStyle = trace.color
        ctx.lineWidth = 1.75
        ctx.lineJoin = 'round'
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * cssW
          // samples 已归一化到 [-1,1]，映射到画布高度并留 6% 边距
          const y = cssH / 2 - (trace.samples[i] ?? 0) * (cssH / 2) * 0.94
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    // 跨屏拖动会改变 devicePixelRatio，也要重绘
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener('change', draw)

    return () => {
      ro.disconnect()
      mq.removeEventListener('change', draw)
    }
  }, [traces, divisionsX, divisionsY, background, grid])

  return (
    <div className={cn('relative h-full w-full overflow-hidden rounded-lg', className)}>
      <canvas ref={canvasRef} className="block" />
    </div>
  )
}

/**
 * 按 1-2-5 序列挑一个 V/div，让信号占满约 5 格 —— 等同示波器的 auto-scale。
 * 写死 V/div 会让小信号缩成一条线、大信号顶出画面。
 */
export function autoVoltsPerDiv(vpp: number, targetDivisions = 5): number {
  if (!Number.isFinite(vpp) || vpp <= 0) return 1
  const ideal = vpp / targetDivisions
  const decade = 10 ** Math.floor(Math.log10(ideal))
  const norm = ideal / decade
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * decade
}

/**
 * 由测量摘要合成一条正弦，用于总览页缩略渲染。
 * 波形原始数组不入库（CLAUDE.md 硬性原则 #4），总览页只有摘要可用。
 */
export function synthesizeSine({
  vpp,
  offsetV,
  voltsPerDiv,
  divisionsY = 8,
  cycles = 3,
  points = 512,
  phaseDeg = 0,
  clipTo,
  acCoupled = false,
}: {
  vpp: number
  offsetV: number
  voltsPerDiv: number
  divisionsY?: number
  cycles?: number
  points?: number
  phaseDeg?: number
  /** 供电轨 [min, max]，用于还原削顶：先按真实偏置生成再钳位 */
  clipTo?: [number, number]
  /** 等同示波器的 AC 耦合：钳位之后再去掉直流分量，波形回到中线 */
  acCoupled?: boolean
}): number[] {
  const fullScale = voltsPerDiv * (divisionsY / 2)
  const amp = vpp / 2
  const phase = (phaseDeg * Math.PI) / 180
  const raw = new Array<number>(points)

  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * cycles * 2 * Math.PI
    let v = offsetV + amp * Math.sin(t + phase)
    if (clipTo) v = Math.min(Math.max(v, clipTo[0]), clipTo[1])
    raw[i] = v
  }

  // 钳位可能已经改变均值，所以直流分量要在钳位后算，不能直接减 offsetV
  const dc = acCoupled ? raw.reduce((a, b) => a + b, 0) / points : 0

  return raw.map((v) => Math.max(-1, Math.min(1, (v - dc) / fullScale)))
}
