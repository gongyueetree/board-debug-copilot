/**
 * @app/ui — 跨页面复用组件
 *
 * docs/03「组件复用要求」列出的目标：RiskPill / StatCard / WaveformCanvas / FftCanvas /
 * MeasureGrid / AiPanel / StepTree / ReportPage。随对应 Phase 逐个补齐。
 */
export { cn } from './cn'
export { FftCanvas, fftMagnitudeDb } from './FftCanvas'
export { RiskPill, type RiskLabel } from './RiskPill'
export { SectionCard } from './SectionCard'
export { StatCard, type StatTone } from './StatCard'
export {
  WaveformCanvas,
  autoVoltsPerDiv,
  synthesizeSine,
  type WaveformTrace,
} from './WaveformCanvas'

/** 所有 AI 面板底部固定文案（docs/03） */
export const AI_DISCLAIMER = '由 AI 生成，内容仅供参考，请结合实际验证。'

/** 通道配色：CH1 绿 / CH2 橙（docs/03 页面 1、页面 3） */
export const CHANNEL_COLORS = { ch1: '#22c55e', ch2: '#f59e0b' } as const
