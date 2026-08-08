'use client'

import { useEffect, useMemo, useRef } from 'react'
import { cn } from './cn'

/**
 * 频域视图。自实现 FFT（迭代 Cooley-Tukey），不引图表库。
 * 窗函数必须真实影响噪底 —— P4 验收项。
 */
export function fftMagnitudeDb(
  samples: number[],
  { window = 'hann' }: { window?: 'hann' | 'none' } = {},
): number[] {
  // 补零到 2 的幂
  let n = 1
  while (n < samples.length) n <<= 1

  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1)

  let coherentGain = 1
  if (window === 'hann') {
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1))
      re[i] = (samples[i]! - mean) * w
      sum += w
    }
    coherentGain = sum / samples.length
  } else {
    for (let i = 0; i < samples.length; i++) re[i] = samples[i]! - mean
  }

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!
        const ui = im[i + k]!
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }

  const half = n >> 1
  const out = new Array<number>(half)
  const norm = (samples.length * coherentGain) / 2
  for (let i = 0; i < half; i++) {
    const mag = Math.hypot(re[i]!, im[i]!) / norm
    out[i] = 20 * Math.log10(Math.max(mag, 1e-9))
  }
  return out
}

export function FftCanvas({
  traces,
  sampleRate,
  minDb = -120,
  maxDb = 0,
  className,
}: {
  traces: { samples: number[]; color: string }[]
  sampleRate: number
  minDb?: number
  maxDb?: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const spectra = useMemo(
    () => traces.map((t) => ({ color: t.color, db: fftMagnitudeDb(t.samples) })),
    [traces],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = parent.clientWidth
      const h = parent.clientHeight
      if (!w || !h) return

      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, 0, w, h)

      const fmin = 100
      const fmax = sampleRate / 2
      const xOf = (f: number) =>
        ((Math.log10(Math.max(f, fmin)) - Math.log10(fmin)) /
          (Math.log10(fmax) - Math.log10(fmin))) *
        w
      const yOf = (db: number) => h - ((db - minDb) / (maxDb - minDb)) * h

      // 对数频率网格
      ctx.strokeStyle = '#1e293b'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let d = Math.log10(fmin); d <= Math.log10(fmax); d++) {
        for (let m = 1; m < 10; m++) {
          const x = Math.round(xOf(10 ** d * m)) + 0.5
          if (x > 0 && x < w) {
            ctx.moveTo(x, 0)
            ctx.lineTo(x, h)
          }
        }
      }
      for (let db = minDb; db <= maxDb; db += 20) {
        const y = Math.round(yOf(db)) + 0.5
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
      }
      ctx.stroke()

      for (const s of spectra) {
        const bins = s.db.length
        ctx.strokeStyle = s.color
        ctx.lineWidth = 1.25
        ctx.beginPath()
        let started = false
        for (let i = 1; i < bins; i++) {
          const f = (i * sampleRate) / (bins * 2)
          if (f < fmin) continue
          const x = xOf(f)
          const y = yOf(Math.max(minDb, Math.min(maxDb, s.db[i]!)))
          if (!started) {
            ctx.moveTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      ctx.fillStyle = '#64748b'
      ctx.font = '9px ui-monospace, monospace'
      for (const f of [100, 1000, 10000, 100000, 1000000]) {
        if (f > fmax) break
        const label = f >= 1e6 ? `${f / 1e6} MHz` : f >= 1e3 ? `${f / 1e3} kHz` : `${f} Hz`
        ctx.fillText(label, Math.min(xOf(f) + 2, w - 40), h - 3)
      }
      for (let db = minDb + 20; db < maxDb; db += 40) {
        ctx.fillText(`${db}`, 2, yOf(db) - 2)
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [spectra, sampleRate, minDb, maxDb])

  return (
    <div className={cn('relative h-full w-full overflow-hidden rounded-lg', className)}>
      <canvas ref={canvasRef} className="block" />
    </div>
  )
}
