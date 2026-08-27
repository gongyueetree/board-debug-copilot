import { describe, expect, it } from 'vitest'
import { computeHomography, generateFootprintRois, projectPoint } from '../src/geometry/registration'

describe('PCB photo registration geometry', () => {
  it('maps four board corners through a perspective homography', () => {
    const src = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 },
    ]
    const dst = [
      { x: 0.10, y: 0.12 }, { x: 0.91, y: 0.08 }, { x: 0.86, y: 0.90 }, { x: 0.14, y: 0.86 },
    ]
    const H = computeHomography(src, dst)
    src.forEach((p, i) => {
      const q = projectPoint(H, p)
      expect(q.x).toBeCloseTo(dst[i].x, 6)
      expect(q.y).toBeCloseTo(dst[i].y, 6)
    })
  })

  it('creates one normalized ROI per footprint from its grouped pads', () => {
    const H = computeHomography(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    )
    const rois = generateFootprintRois([
      { ref: 'U1', x: 50, y: 50, pads: [{ x: 45, y: 48 }, { x: 55, y: 52 }] },
      { ref: 'J2', x: 80, y: 20, pads: [{ x: 80, y: 20 }] },
    ], H)
    expect(rois).toHaveLength(2)
    expect(rois[0].ref).toBe('U1')
    expect(rois[0].w).toBeGreaterThan(0.1)
    expect(rois[0].center.x).toBeCloseTo(0.5, 4)
    expect(rois[0].center.y).toBeCloseTo(0.5, 4)
    expect(rois[1].x).toBeGreaterThan(0.7)
  })
})
