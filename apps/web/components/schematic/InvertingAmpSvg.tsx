/**
 * Demo 电路缩略图：AD8605 单电源反相放大器。
 *
 * 内嵌 SVG，零外部依赖（MOCK_MODE 下无对象存储）。
 * P3 的设计审查页会换成从 KiCad 导出的完整原理图。
 */
export function InvertingAmpSvg({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 180"
      className={className}
      role="img"
      aria-label="AD8605 反相放大器原理图缩略"
    >
      <g
        fill="none"
        stroke="#334155"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Rf 反馈支路 */}
        <path d="M118 46 H150" />
        <rect x="150" y="38" width="34" height="16" rx="2" />
        <path d="M184 46 H236 V88" />

        {/* 输入支路 Vin -> Rin -> 反相端 */}
        <path d="M26 88 H62" />
        <rect x="62" y="80" width="34" height="16" rx="2" />
        <path d="M96 88 H118 V46 M118 88 H140" />
        <circle cx="118" cy="88" r="2.5" fill="#334155" />

        {/* 运放三角 */}
        <path d="M140 66 L140 134 L196 100 Z" fill="#f8fafc" />
        <path d="M196 100 H236 M236 100 H272" />
        <path d="M132 88 H140 M132 112 H140" />

        {/* 同相端接 Vref（当前设计缺陷点：网表里接的是 GND） */}
        <path d="M132 112 H112 V140" />
        <path d="M104 140 H120" stroke="#dc2626" strokeWidth="2" />
        <path d="M107 145 H117" stroke="#dc2626" strokeWidth="2" />
        <path d="M110 150 H114" stroke="#dc2626" strokeWidth="2" />

        {/* 供电 */}
        <path d="M168 62 V46" />
        <path d="M168 138 V152 M161 152 H175 M164 157 H172 M166 162 H170" />

        {/* 测试点 */}
        <circle cx="108" cy="88" r="3" fill="#fff" />
        <circle cx="252" cy="100" r="3" fill="#fff" />
      </g>

      <g fontSize="9" fill="#475569" fontFamily="ui-sans-serif, system-ui">
        <text x="152" y="34">
          Rf 100k
        </text>
        <text x="64" y="76">
          Rin 10k
        </text>
        <text x="12" y="84">
          Vin
        </text>
        <text x="276" y="103">
          Vout
        </text>
        <text x="152" y="42" fill="#94a3b8" />
        <text x="158" y="44" />
        <text x="150" y="112" fill="#1e293b" fontSize="9" fontWeight="600">
          U1
        </text>
        <text x="150" y="123" fill="#94a3b8" fontSize="8">
          AD8605
        </text>
        <text x="172" y="44" fill="#94a3b8" fontSize="8">
          +5V
        </text>
        <text x="98" y="86" fill="#94a3b8" fontSize="8">
          TP1
        </text>
        <text x="244" y="94" fill="#94a3b8" fontSize="8">
          TP2
        </text>
        <text x="86" y="144" fill="#dc2626" fontSize="8">
          U1.3 接 GND
        </text>
      </g>

      <g fontSize="9" fill="#0f172a" fontFamily="ui-sans-serif, system-ui">
        <text x="132" y="90">
          −
        </text>
        <text x="132" y="116">
          +
        </text>
      </g>
    </svg>
  )
}
