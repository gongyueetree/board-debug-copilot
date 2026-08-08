/** 接线指南插图（docs/03 页面 3）：ADALM2000 ↔ 板卡连线示意 */
export function WiringGuide() {
  const links = [
    { y: 26, color: '#22c55e', label: 'CH1', to: 'TP1 (IN)' },
    { y: 48, color: '#f59e0b', label: 'CH2', to: 'TP2 (OUT)' },
    { y: 70, color: '#3b82f6', label: 'W1', to: 'TP3 (VREF)' },
    { y: 92, color: '#64748b', label: 'GND', to: '板卡地' },
  ]

  return (
    <svg viewBox="0 0 300 120" className="w-full" role="img" aria-label="ADALM2000 接线示意">
      <rect x="6" y="14" width="72" height="94" rx="6" fill="#1e293b" />
      <text x="42" y="66" textAnchor="middle" fontSize="9" fill="#94a3b8">
        ADALM2000
      </text>

      <rect x="200" y="14" width="94" height="94" rx="4" fill="#0f4a38" stroke="#0a3f30" />
      <rect x="228" y="40" width="34" height="24" rx="2" fill="#0f172a" />
      <text x="245" y="55" textAnchor="middle" fontSize="7" fill="#94a3b8">
        U1
      </text>
      <text x="247" y="102" textAnchor="middle" fontSize="7" fill="#4ade80">
        SENSOR-BOARD
      </text>

      {links.map((l) => (
        <g key={l.label}>
          <path
            d={`M78 ${l.y} C 120 ${l.y}, 160 ${l.y}, 200 ${l.y}`}
            stroke={l.color}
            strokeWidth="2"
            fill="none"
          />
          <circle cx="78" cy={l.y} r="3" fill={l.color} />
          <circle cx="200" cy={l.y} r="3" fill={l.color} />
          <text x="86" y={l.y - 4} fontSize="7" fill={l.color} fontWeight="600">
            {l.label}
          </text>
          <text x="140" y={l.y - 4} fontSize="7" fill="#94a3b8">
            {l.to}
          </text>
        </g>
      ))}
    </svg>
  )
}
