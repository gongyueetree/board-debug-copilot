export interface Point2D { x: number; y: number }
export interface Homography { h: [number, number, number, number, number, number, number, number, number] }

function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    if (Math.abs(m[pivot][col]) < 1e-10) throw new Error('Homography points are degenerate')
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    const d = m[col][col]
    for (let c = col; c <= n; c++) m[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col]
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return m.map((r) => r[n])
}

/** Four exact point correspondences → 3x3 homography (h33 fixed to 1). */
export function computeHomography(src: Point2D[], dst: Point2D[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error('computeHomography requires exactly 4 point pairs')
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  const q = solveLinear(a, b)
  return { h: [q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], 1] }
}

export function projectPoint(H: Homography, p: Point2D): Point2D {
  const h = H.h
  const w = h[6] * p.x + h[7] * p.y + h[8]
  if (Math.abs(w) < 1e-12) throw new Error('Homography projected point at infinity')
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  }
}

export interface FootprintGeometry {
  ref: string
  x: number
  y: number
  pads: Point2D[]
}

export interface FootprintRoi {
  ref: string
  x: number
  y: number
  w: number
  h: number
  polygon: Point2D[]
  center: Point2D
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * Build an image-normalized ROI for every footprint. Pad extents define the physical
 * component region; a fixed + proportional margin leaves room for the package body.
 */
export function generateFootprintRois(
  footprints: FootprintGeometry[],
  H: Homography,
  marginMm = 2.0,
): FootprintRoi[] {
  return footprints.map((fp) => {
    const pts = fp.pads.length ? fp.pads : [{ x: fp.x, y: fp.y }]
    let minX = Math.min(...pts.map((p) => p.x), fp.x)
    let maxX = Math.max(...pts.map((p) => p.x), fp.x)
    let minY = Math.min(...pts.map((p) => p.y), fp.y)
    let maxY = Math.max(...pts.map((p) => p.y), fp.y)
    const spanX = Math.max(0.8, maxX - minX)
    const spanY = Math.max(0.8, maxY - minY)
    const mx = Math.max(marginMm, spanX * 0.45)
    const my = Math.max(marginMm, spanY * 0.45)
    minX -= mx; maxX += mx; minY -= my; maxY += my

    const polygon = [
      projectPoint(H, { x: minX, y: minY }),
      projectPoint(H, { x: maxX, y: minY }),
      projectPoint(H, { x: maxX, y: maxY }),
      projectPoint(H, { x: minX, y: maxY }),
    ].map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y)
    const x = Math.min(...xs), y = Math.min(...ys)
    const right = Math.max(...xs), bottom = Math.max(...ys)
    return {
      ref: fp.ref,
      x: Number(x.toFixed(5)), y: Number(y.toFixed(5)),
      w: Number((right - x).toFixed(5)), h: Number((bottom - y).toFixed(5)),
      polygon: polygon.map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) })),
      center: (() => { const p = projectPoint(H, { x: fp.x, y: fp.y }); return { x: Number(clamp01(p.x).toFixed(5)), y: Number(clamp01(p.y).toFixed(5)) } })(),
    }
  })
}
