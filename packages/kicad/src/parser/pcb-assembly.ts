export interface AssemblyPad {
  number: string
  x: number
  y: number
  shape?: string
}

export interface AssemblyFootprint {
  ref: string
  value: string
  footprint: string
  x: number
  y: number
  rotation: number
  side: 'front' | 'back'
  pads: AssemblyPad[]
  excluded: boolean
  excludeReason?: string
}

export interface PcbAssemblyMap {
  footprints: AssemblyFootprint[]
  inspectable: AssemblyFootprint[]
  /** Physical board outline when Edge.Cuts is available; footprint extents are fallback. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  boundsSource: 'edge-cuts' | 'footprints'
}

function blocks(src: string, head: string): string[] {
  const out: string[] = []
  let pos = 0
  const needle = `(${head}`
  while ((pos = src.indexOf(needle, pos)) >= 0) {
    let depth = 0
    let quote = false
    let escaped = false
    let end = pos
    for (; end < src.length; end++) {
      const c = src[end]
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quote = false
        continue
      }
      if (c === '"') { quote = true; continue }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) { end++; break }
    }
    out.push(src.slice(pos, end))
    pos = end
  }
  return out
}

function strProp(block: string, key: string): string {
  const re1 = new RegExp(`\\(property\\s+"${key}"\\s+"([^"]*)"`, 'i')
  const re2 = new RegExp(`\\(fp_text\\s+${key.toLowerCase()}\\s+"([^"]*)"`, 'i')
  return re1.exec(block)?.[1] ?? re2.exec(block)?.[1] ?? ''
}

function atOf(block: string) {
  const m = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\)/.exec(block)
  return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0), rotation: Number(m?.[3] ?? 0) }
}

function rotate(x: number, y: number, deg: number) {
  const r = (deg * Math.PI) / 180
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) }
}

function exclude(ref: string, value: string, footprint: string) {
  const s = `${ref} ${value} ${footprint}`.toLowerCase()
  if (/mountinghole|mounting_hole|tooling|fiducial/.test(s)) return 'mechanical'
  if (/testpoint|test_point/.test(s) || /^tp\d+/i.test(ref)) return 'test-point'
  if (/pogopin|pogo_pin/.test(s)) return 'pogo-contact'
  return ''
}

function boundsOf(points: { x: number; y: number }[]) {
  return points.length
    ? { minX: Math.min(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxX: Math.max(...points.map((p) => p.x)), maxY: Math.max(...points.map((p) => p.y)) }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}

/** Approximate board outline bounds from all geometry that lives on Edge.Cuts. */
function edgeCutPoints(src: string): { x: number; y: number }[] {
  const heads = ['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'segment']
  const points: { x: number; y: number }[] = []
  for (const head of heads) {
    for (const b of blocks(src, head)) {
      if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(b)) continue
      const coord = /\((?:start|end|mid|center|xy)\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g
      let m: RegExpExecArray | null
      while ((m = coord.exec(b))) points.push({ x: Number(m[1]), y: Number(m[2]) })
    }
  }
  return points
}

export function parsePcbAssembly(src: string): PcbAssemblyMap {
  const fps = [...blocks(src, 'footprint'), ...blocks(src, 'module')]
  const footprints: AssemblyFootprint[] = fps.map((b) => {
    const at = atOf(b)
    const layer = /\(layer\s+"?([^"\s)]+)"?\)/.exec(b)?.[1] ?? 'F.Cu'
    const ref = strProp(b, 'Reference') || 'UNKNOWN'
    const value = strProp(b, 'Value')
    const footprint = /^\((?:footprint|module)\s+"?([^"\s)]+)"?/.exec(b)?.[1] ?? ''
    const reason = exclude(ref, value, footprint)
    const pads = blocks(b, 'pad').map((p) => {
      const n = /^\(pad\s+"?([^"\s)]+)"?\s+[^\s)]+\s+([^\s)]+)/.exec(p)
      const pa = atOf(p)
      const local = rotate(pa.x, pa.y, at.rotation)
      return { number: n?.[1] ?? '', x: at.x + local.x, y: at.y + local.y, shape: n?.[2] }
    })
    return {
      ref, value, footprint, x: at.x, y: at.y, rotation: at.rotation,
      side: layer.startsWith('B.') ? 'back' as const : 'front' as const,
      pads, excluded: Boolean(reason), excludeReason: reason || undefined,
    }
  }).filter((f) => f.ref && f.ref !== 'REF**')

  const inspectable = footprints.filter((f) => !f.excluded && f.pads.length > 0)
  const edge = edgeCutPoints(src)
  const fpPoints = footprints.flatMap((f) => [{ x: f.x, y: f.y }, ...f.pads.map((p) => ({ x: p.x, y: p.y }))])
  const bounds = boundsOf(edge.length >= 2 ? edge : fpPoints)
  return { footprints, inspectable, bounds, boundsSource: edge.length >= 2 ? 'edge-cuts' : 'footprints' }
}

export function assemblyPromptTable(map: PcbAssemblyMap, side: 'front' | 'back' = 'front') {
  const f = map.inspectable.filter((x) => x.side === side)
  const dx = Math.max(1e-6, map.bounds.maxX - map.bounds.minX)
  const dy = Math.max(1e-6, map.bounds.maxY - map.bounds.minY)
  return f.map((x) => ({
    ref: x.ref,
    value: x.value,
    footprint: x.footprint,
    x: Number(((x.x - map.bounds.minX) / dx).toFixed(4)),
    y: Number(((x.y - map.bounds.minY) / dy).toFixed(4)),
    rotation: x.rotation,
    padCount: x.pads.length,
    padNumbers: x.pads.map((p) => p.number).filter(Boolean).slice(0, 32),
  }))
}
