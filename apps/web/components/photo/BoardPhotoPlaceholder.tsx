import { cn } from '@app/ui'

/**
 * PCB 实物照片占位。
 *
 * MOCK_MODE 下没有对象存储，也不放任何外部图片依赖，
 * 所以用 SVG 画一块示意板卡。器件位置对应 seed 里的 Component.x/y。
 * P5 接入真实照片后，这个组件只在缺图时兜底。
 */
const PARTS: { ref: string; x: number; y: number; w: number; h: number; kind: 'ic' | 'passive' | 'conn' }[] = [
  { ref: 'U1', x: 118, y: 74, w: 44, h: 30, kind: 'ic' },
  { ref: 'U2', x: 196, y: 142, w: 26, h: 18, kind: 'ic' },
  { ref: 'U3', x: 52, y: 194, w: 24, h: 16, kind: 'ic' },
  { ref: 'R1', x: 136, y: 54, w: 14, h: 7, kind: 'passive' },
  { ref: 'R2', x: 154, y: 54, w: 14, h: 7, kind: 'passive' },
  { ref: 'R3', x: 96, y: 76, w: 14, h: 7, kind: 'passive' },
  { ref: 'R4', x: 206, y: 124, w: 12, h: 6, kind: 'passive' },
  { ref: 'R5', x: 222, y: 124, w: 12, h: 6, kind: 'passive' },
  { ref: 'R6', x: 168, y: 76, w: 14, h: 7, kind: 'passive' },
  { ref: 'C1', x: 44, y: 214, w: 16, h: 9, kind: 'passive' },
  { ref: 'C2', x: 140, y: 64, w: 10, h: 6, kind: 'passive' },
  { ref: 'C3', x: 68, y: 214, w: 12, h: 7, kind: 'passive' },
  { ref: 'C4', x: 86, y: 214, w: 12, h: 7, kind: 'passive' },
  { ref: 'Cdec1', x: 88, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'Cdec2', x: 102, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'Cdec3', x: 116, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'Cdec4', x: 130, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'Cdec5', x: 144, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'Cdec6', x: 158, y: 242, w: 10, h: 6, kind: 'passive' },
  { ref: 'J1', x: 14, y: 74, w: 22, h: 30, kind: 'conn' },
  { ref: 'J2', x: 244, y: 74, w: 22, h: 30, kind: 'conn' },
]

const FILL = { ic: '#0f172a', passive: '#1f2937', conn: '#a16207' } as const

export function BoardPhotoPlaceholder({
  highlight,
  className,
}: {
  highlight?: string | null
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 280 280"
      className={cn('bg-[#0d3b2e]', className)}
      role="img"
      aria-label={highlight ? `PCB 实物照片，高亮 ${highlight}` : 'PCB 实物照片'}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect x="0" y="0" width="280" height="280" fill="#0f4a38" />
      <rect x="6" y="6" width="268" height="268" rx="6" fill="#116149" stroke="#0a3f30" />

      {/* 定位孔 */}
      {[
        [20, 20],
        [260, 20],
        [20, 260],
        [260, 260],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="5" fill="#0a3f30" stroke="#cbd5e1" />
      ))}

      {/* 走线 */}
      <g stroke="#d4a72c" strokeWidth="1.6" fill="none" opacity="0.75">
        <path d="M36 89 H96 M110 89 H118" />
        <path d="M162 89 H244" />
        <path d="M143 74 V60 M143 60 H136 M150 60 H168 M168 60 V74" />
        <path d="M76 202 H196 M196 202 V160" />
        <path d="M212 124 V142 M228 124 V142" />
      </g>

      {/* 器件 */}
      {PARTS.map((p) => {
        const on = highlight === p.ref
        return (
          <g key={p.ref}>
            <rect
              x={p.x}
              y={p.y}
              width={p.w}
              height={p.h}
              rx={p.kind === 'ic' ? 2 : 1}
              fill={FILL[p.kind]}
              stroke={p.kind === 'conn' ? '#eab308' : '#334155'}
              strokeWidth="0.6"
            />
            {p.kind === 'ic' && (
              <text
                x={p.x + p.w / 2}
                y={p.y + p.h / 2 + 3}
                textAnchor="middle"
                fontSize="7"
                fill="#94a3b8"
                fontFamily="ui-monospace, monospace"
              >
                {p.ref}
              </text>
            )}
            {on && (
              <>
                <rect
                  x={p.x - 6}
                  y={p.y - 6}
                  width={p.w + 12}
                  height={p.h + 12}
                  rx="3"
                  fill="none"
                  stroke="#facc15"
                  strokeWidth="2"
                />
                <text
                  x={p.x + p.w / 2}
                  y={p.y - 10}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#facc15"
                  fontWeight="600"
                  fontFamily="ui-sans-serif, system-ui"
                >
                  {p.ref}
                </text>
              </>
            )}
          </g>
        )
      })}

      <text
        x="140"
        y="272"
        textAnchor="middle"
        fontSize="8"
        fill="#4ade80"
        fontFamily="ui-monospace, monospace"
        opacity="0.7"
      >
        SENSOR-BOARD-V1.0
      </text>
    </svg>
  )
}
