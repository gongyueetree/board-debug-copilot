'use client'

import {
  AI_DISCLAIMER,
  CHANNEL_COLORS,
  FftCanvas,
  SectionCard,
  WaveformCanvas,
  autoVoltsPerDiv,
  cn,
} from '@app/ui'
import { useMemo, useState } from 'react'
import type { Measurements, Scenario } from '@app/contracts'
import { needsConfirm, useBridge, type AwgRequest } from '@/lib/bridge'
import { useAnalyzeCapture, useSaveCapture } from '@/lib/mutations'
import { WiringGuide } from './WiringGuide'

const PRESETS: { id: string; name: string; desc: string; awg: AwgRequest }[] = [
  {
    id: 'gain',
    name: '输入-输出 增益测量',
    desc: '测量放大器增益与相位',
    awg: { channel: 'W2', wave: 'sine', freqHz: 1000, amplitudeVpp: 0.4, offsetV: 0 },
  },
  {
    id: 'bandwidth',
    name: '带宽测试',
    desc: '扫频响应',
    awg: { channel: 'W2', wave: 'sine', freqHz: 10000, amplitudeVpp: 0.4, offsetV: 0 },
  },
  {
    id: 'ripple',
    name: '电源纹波检查',
    desc: '评估电源噪声',
    awg: { channel: 'W1', wave: 'dc', freqHz: 0, amplitudeVpp: 0, offsetV: 2.5 },
  },
]

const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'normal', label: '正常' },
  { id: 'gain_error', label: '增益异常' },
  { id: 'clipping', label: '削顶' },
  { id: 'noisy', label: '噪声' },
  { id: 'no_response', label: '无响应' },
]

export function BenchClient({ projectId }: { projectId: string }) {
  const bridge = useBridge()
  const [awg, setAwg] = useState<AwgRequest>(PRESETS[0]!.awg)
  const [preset, setPreset] = useState('gain')
  const [confirmFor, setConfirmFor] = useState<AwgRequest | null>(null)
  const [applied, setApplied] = useState<string>('')
  const [saved, setSaved] = useState<string>('')
  const saveCapture = useSaveCapture(projectId)
  const analyzeCapture = useAnalyzeCapture(projectId)

  const m = bridge.measurements
  const wf = bridge.waveform

  const traces = useMemo(() => {
    if (!wf) return null
    const v1 = autoVoltsPerDiv(Math.max(...wf.ch1) - Math.min(...wf.ch1) || 1)
    const v2 = autoVoltsPerDiv(Math.max(...wf.ch2) - Math.min(...wf.ch2) || 1)
    const norm = (arr: number[], vdiv: number) => {
      const dc = arr.reduce((a, b) => a + b, 0) / arr.length
      const full = vdiv * 4
      return arr.map((v) => Math.max(-1, Math.min(1, (v - dc) / full)))
    }
    return { v1, v2, ch1: norm(wf.ch1, v1), ch2: norm(wf.ch2, v2) }
  }, [wf])

  const submit = async (req: AwgRequest, confirmed = false) => {
    if (needsConfirm(req) && !confirmed) {
      setConfirmFor(req)
      return
    }
    try {
      await bridge.applyAwg({ ...req, confirm: confirmed })
      setApplied(`已输出：${req.channel} ${req.wave} ${req.freqHz}Hz ${req.amplitudeVpp}Vpp`)
    } catch (err) {
      setApplied(`失败：${(err as Error).message}`)
    }
    setConfirmFor(null)
  }

  if (!bridge.status?.connected) {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-6">
        <h2 className="text-sm font-medium text-amber-900">未检测到本地 Bridge</h2>
        <p className="mt-2 text-xs leading-relaxed text-amber-800">
          浏览器直连本机 <code>127.0.0.1:3777</code>，云端不经手 USB 设备。请在本机启动 Bridge：
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-3 text-[11px] text-slate-700">
          {`cd apps/m2k-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
BRIDGE_MOCK=true uvicorn src.main:app --host 127.0.0.1 --port 3777`}
        </pre>
        <p className="mt-2 text-[11px] text-amber-700">
          无 ADALM2000 硬件时保持 <code>BRIDGE_MOCK=true</code> 即可用合成波形跑通全流程。
          需使用 Chrome 或 Edge（https 页面连 ws://127.0.0.1 依赖 localhost 豁免）。
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">
      <div className="flex min-h-0 flex-1 gap-3">
        {/* 左：接线与测试设置 */}
        <aside className="flex w-[340px] shrink-0 flex-col gap-3 overflow-auto">
          <SectionCard title="接线与测试设置" bodyClassName="p-3">
            <WiringGuide />
            <ul className="mt-3 space-y-1">
              {[
                '连接 CH1 → TP1 (IN)',
                '连接 CH2 → TP2 (OUT)',
                '连接 W1 → TP3 (VREF，2.5V 偏置)',
                '连接 GND → 板卡地',
                '确认 ADALM2000 已连接并被识别',
              ].map((t, i) => (
                <li key={t} className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span className="w-3 text-slate-400">{i + 1}</span>
                  <span className="flex-1">{t}</span>
                  <span className="text-emerald-500">✓</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="信号源设置（ADALM2000 AWG）" bodyClassName="p-3">
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <Field label="波形">
                <select
                  value={awg.wave}
                  onChange={(e) => setAwg({ ...awg, wave: e.target.value as AwgRequest['wave'] })}
                  className="w-full rounded border border-slate-200 px-2 py-1"
                >
                  {['sine', 'square', 'triangle', 'sawtooth', 'dc'].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="频率 (Hz)">
                <input
                  type="number"
                  value={awg.freqHz}
                  onChange={(e) => setAwg({ ...awg, freqHz: Number(e.target.value) })}
                  className="w-full rounded border border-slate-200 px-2 py-1"
                />
              </Field>
              <Field label="幅度 (Vpp)">
                <input
                  type="number"
                  step="0.1"
                  value={awg.amplitudeVpp}
                  onChange={(e) => setAwg({ ...awg, amplitudeVpp: Number(e.target.value) })}
                  className="w-full rounded border border-slate-200 px-2 py-1"
                />
              </Field>
              <Field label="偏置 (V)">
                <input
                  type="number"
                  step="0.1"
                  value={awg.offsetV}
                  onChange={(e) => setAwg({ ...awg, offsetV: Number(e.target.value) })}
                  className="w-full rounded border border-slate-200 px-2 py-1"
                />
              </Field>
              <Field label="输出通道">
                <select
                  value={awg.channel}
                  onChange={(e) =>
                    setAwg({ ...awg, channel: e.target.value as AwgRequest['channel'] })
                  }
                  className="w-full rounded border border-slate-200 px-2 py-1"
                >
                  <option value="W1">W1</option>
                  <option value="W2">W2</option>
                </select>
              </Field>
              <Field label="输出阻抗">
                <div className="rounded border border-slate-200 px-2 py-1 text-slate-500">
                  高阻抗
                </div>
              </Field>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPreset(p.id)
                    setAwg(p.awg)
                  }}
                  className={cn(
                    'rounded-lg border p-1.5 text-left text-[10px] leading-tight',
                    preset === p.id
                      ? 'border-brand bg-blue-50 text-brand'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                  )}
                >
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-slate-400">{p.desc}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => submit(awg)}
              className="mt-3 w-full rounded-lg bg-brand py-2 text-xs font-medium text-white hover:bg-brand-hover"
            >
              应用信号源输出
            </button>
            {needsConfirm(awg) && (
              <p className="mt-1 text-[10px] text-orange-600">
                幅度 &gt; 5Vpp 或偏置 ≠ 0，提交时会要求二次确认
              </p>
            )}
            {applied && <p className="mt-1 text-[10px] text-slate-500">{applied}</p>}
          </SectionCard>

          <SectionCard title="Mock 场景" bodyClassName="p-3">
            <div className="flex flex-wrap gap-1.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => bridge.setScenario(s.id)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px]',
                    bridge.status?.scenario === s.id
                      ? 'bg-brand text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-slate-400">
              数值规格见 docs/05 §11.1，噪声用固定随机种子，演示可复现。
            </p>
          </SectionCard>
        </aside>

        {/* 中：波形与测量 */}
        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
          <SectionCard
            title="实时波形（时域）"
            action={
              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                <span>{traces ? `${traces.v1} / ${traces.v2} V/div` : '—'}</span>
                <button
                  type="button"
                  onClick={() => bridge.setRunning(!bridge.status?.running)}
                  className={cn(
                    'rounded px-2 py-0.5 font-medium',
                    bridge.status?.running
                      ? 'bg-red-50 text-red-600'
                      : 'bg-emerald-50 text-emerald-600',
                  )}
                >
                  {bridge.status?.running ? '● 停止' : '▶ 运行'}
                </button>
              </div>
            }
            bodyClassName="p-3"
          >
            <div className="mb-2 flex gap-3 text-[11px]">
              <Tag color={CHANNEL_COLORS.ch1}>CH1: TP1 (IN)</Tag>
              <Tag color={CHANNEL_COLORS.ch2}>CH2: TP2 (OUT)</Tag>
            </div>
            <div className="h-[200px]">
              {traces ? (
                <WaveformCanvas
                  traces={[
                    { samples: traces.ch1, color: CHANNEL_COLORS.ch1 },
                    { samples: traces.ch2, color: CHANNEL_COLORS.ch2 },
                  ]}
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg bg-slate-900 text-xs text-slate-500">
                  {bridge.wsOpen ? '等待波形帧…' : '正在连接 Bridge WebSocket…'}
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="频域（FFT）"
            action={<span className="text-[11px] text-slate-500">Hann 窗 · 1024 线</span>}
            bodyClassName="p-3"
          >
            <div className="h-[160px]">
              {wf ? (
                <FftCanvas
                  sampleRate={wf.fs / 4}
                  traces={[
                    { samples: wf.ch1, color: CHANNEL_COLORS.ch1 },
                    { samples: wf.ch2, color: CHANNEL_COLORS.ch2 },
                  ]}
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg bg-slate-900 text-xs text-slate-500">
                  等待数据
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard title="测量结果" bodyClassName="p-3">
            {m ? (
              <div className="grid grid-cols-4 gap-2 xl:grid-cols-7">
                <Measure label="Vpp" ch1={`${m.ch1.vpp.toFixed(3)} V`} ch2={`${m.ch2.vpp.toFixed(3)} V`} />
                <Measure label="Vrms" ch1={`${m.ch1.vrms.toFixed(3)} V`} ch2={`${m.ch2.vrms.toFixed(3)} V`} />
                <Measure
                  label="Freq"
                  ch1={`${(m.ch1.freqHz / 1000).toFixed(3)} kHz`}
                  ch2={`${(m.ch2.freqHz / 1000).toFixed(3)} kHz`}
                />
                <Measure label="Offset" ch1={`${(m.ch1.offsetV * 1000).toFixed(1)} mV`} ch2={`${(m.ch2.offsetV * 1000).toFixed(1)} mV`} />
                <Measure label="THD+N" ch1={`${(m.ch1.thdnPct ?? 0).toFixed(2)} %`} ch2={`${(m.ch2.thdnPct ?? 0).toFixed(2)} %`} />
                <Measure label="Gain (CH2/CH1)" ch1={`${m.gain.toFixed(2)} V/V`} ch2={`${m.gainDb.toFixed(2)} dB`} />
                <Measure label="Phase" ch1={`${m.phaseDeviationDeg.toFixed(1)}°`} ch2="相对反相理想值" />
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-slate-400">等待测量帧</p>
            )}
          </SectionCard>
        </section>

        {/* 右：AI 调试参谋 */}
        <aside className="w-[320px] shrink-0 overflow-auto">
          <SectionCard title="AI 调试参谋" bodyClassName="p-3">
            {m ? (
              <BenchAnalysis measurements={m} scenario={bridge.status.scenario} />
            ) : (
              <p className="text-xs text-slate-400">等待测量数据</p>
            )}

            {m && (
              <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  disabled={saveCapture.isPending || analyzeCapture.isPending}
                  onClick={() =>
                    saveCapture.mutate(
                      {
                        label: `${bridge.status?.scenario ?? 'manual'} @ ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
                        netName: 'VOUT_AMP',
                        hardwareSetup: {
                          scenario: bridge.status?.scenario,
                          instrument: 'ADALM2000',
                          awg,
                        },
                        measurements: m,
                        // 原始数组进对象存储，不入库（硬性原则 #4）
                        waveform: wf ? { ch1: wf.ch1, ch2: wf.ch2, fs: wf.fs } : undefined,
                      },
                      {
                        onSuccess: (r) => {
                          setSaved('已保存捕获，正在分析…')
                          analyzeCapture.mutate(r.id, {
                            onSuccess: (d) =>
                              setSaved(
                                `分析完成：${d.primaryCode ?? '无异常'}（置信度 ${Math.round(d.confidence * 100)}%）`,
                              ),
                            onError: (e) => setSaved(`分析失败：${e.message}`),
                          })
                        },
                        onError: (e) => setSaved(`保存失败：${e.message}`),
                      },
                    )
                  }
                  className="w-full rounded-lg bg-brand py-2 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-50"
                >
                  {saveCapture.isPending
                    ? '保存中…'
                    : analyzeCapture.isPending
                      ? '分析中…'
                      : '保存捕获并分析'}
                </button>
                {saved && <p className="text-[10px] text-slate-500">{saved}</p>}
              </div>
            )}
            <p className="mt-3 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
              {AI_DISCLAIMER}
            </p>
          </SectionCard>
        </aside>
      </div>

      <footer className="flex shrink-0 items-center gap-4 rounded-card border border-slate-200 bg-white px-4 py-2 text-[11px] text-slate-500">
        <span>设备：{bridge.status.device}</span>
        <span>序列号：{bridge.status.serial}</span>
        <span>固件：{bridge.status.firmware}</span>
        <span className="flex items-center gap-1">
          <span
            className={cn('h-2 w-2 rounded-full', bridge.wsOpen ? 'bg-emerald-500' : 'bg-slate-400')}
          />
          {bridge.wsOpen ? 'WebSocket 已连接' : '未连接'}
        </span>
        {bridge.status.mock && (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-600">MOCK 模式</span>
        )}
        <span className="ml-auto">场景：{bridge.status.scenario}</span>
      </footer>

      {confirmFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-card bg-white p-5">
            <h3 className="text-sm font-semibold text-slate-900">确认危险仪器操作</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              即将输出 <strong>{confirmFor.amplitudeVpp} Vpp</strong>，直流偏置{' '}
              <strong>{confirmFor.offsetV} V</strong>，通道 {confirmFor.channel}。
              请确认被测板卡能够承受该电平，且接线正确。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmFor(null)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-xs text-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => submit(confirmFor, true)}
                className="flex-1 rounded-lg bg-red-600 py-2 text-xs font-medium text-white"
              >
                确认输出
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-slate-500">{label}</span>
      {children}
    </label>
  )
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-medium" style={{ color }}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {children}
    </span>
  )
}

function Measure({ label, ch1, ch2 }: { label: string; ch1: string; ch2: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[11px] font-medium" style={{ color: CHANNEL_COLORS.ch1 }}>
        {ch1}
      </div>
      <div className="text-[11px]" style={{ color: CHANNEL_COLORS.ch2 }}>
        {ch2}
      </div>
    </div>
  )
}

/**
 * 实时解读。判定顺序固定：先削顶 → 再增益 → 再频率 → 再噪声（docs/05 §8.4 规则 8）。
 * 这一层是确定性的，与规则引擎同源；LLM 分析走「保存捕获后分析」。
 */
function BenchAnalysis({ measurements: m, scenario }: { measurements: Measurements; scenario: string }) {
  const expectedGain = 10
  const thd = m.ch2.thdnPct ?? 0
  const railed = m.ch2.vmax > 4.9 || m.ch2.vmin < 0.1
  const items: { tone: 'ok' | 'warn' | 'bad'; text: string }[] = []

  if (m.ch2.vpp < 0.05) {
    items.push({ tone: 'bad', text: `输出无响应：CH2 Vpp ${m.ch2.vpp.toFixed(3)}V，直流 ${(m.ch2.offsetV * 1000).toFixed(0)}mV 贴轨底` })
    items.push({ tone: 'bad', text: '优先怀疑单电源缺 Vref 偏置：测 TP3 直流应为 2.5V' })
  } else if (thd > 5 && railed) {
    items.push({ tone: 'bad', text: `削顶：THD+N ${thd.toFixed(1)}%，Vmax ${m.ch2.vmax.toFixed(2)}V 已贴轨` })
    items.push({ tone: 'warn', text: `先降低 W2 幅度到 ≤${(4.96 / expectedGain).toFixed(2)}Vpp 再评估增益` })
  } else if (Math.abs(m.gain - expectedGain) / expectedGain > 0.1) {
    items.push({
      tone: 'bad',
      text: `增益不符：期望 ${expectedGain}，实测 ${m.gain.toFixed(2)}（${((m.gain / expectedGain) * 100).toFixed(0)}%）`,
    })
    items.push({
      tone: 'warn',
      text: `THD+N 仅 ${thd.toFixed(2)}% 且未贴轨，排除削顶导致的增益下降 → 查反馈网络阻值`,
    })
    if (Math.abs(m.gain - expectedGain / 2) < 0.3) {
      items.push({ tone: 'warn', text: '实测恰为期望的 1/2，等效 Rf ≈ 50k，怀疑 Rf 被并联或桥接' })
    }
  } else {
    items.push({ tone: 'ok', text: `增益 ${m.gain.toFixed(2)} 符合设计预期` })
    items.push({ tone: 'ok', text: `放大器工作在线性区，未饱和（THD+N ${thd.toFixed(2)}%）` })
  }

  if (thd > 1 && thd < 5) {
    items.push({ tone: 'warn', text: `噪声偏高：THD+N ${thd.toFixed(2)}%，检查去耦与地回路` })
  }
  items.push({
    tone: 'warn',
    text: `相位 ${m.phaseDeviationDeg.toFixed(1)}°（相对反相理想值 180°），存在轻微滞后`,
  })

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-900">实时解读</div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.text} className="flex gap-1.5 text-[11px] leading-relaxed">
            <span
              className={cn(
                'mt-0.5 shrink-0',
                it.tone === 'ok'
                  ? 'text-emerald-500'
                  : it.tone === 'warn'
                    ? 'text-orange-500'
                    : 'text-red-500',
              )}
            >
              {it.tone === 'ok' ? '✓' : it.tone === 'warn' ? '!' : '×'}
            </span>
            <span className="text-slate-600">{it.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-400">
        当前场景 {scenario}；解读由确定性判定链给出，与规则引擎同源
      </p>
    </div>
  )
}
