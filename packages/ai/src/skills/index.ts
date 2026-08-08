/**
 * L4 技能层 —— 每个技能声明它要什么上下文、输出什么 schema。
 * 规格见 docs/05 §4.3（预算表）与 §8.3（各技能差异）。
 */
import type { AgentIntent } from '@app/contracts'

export interface SkillSpec {
  intent: AgentIntent
  /** 装配哪些上下文 slice */
  slices: ('designDigest' | 'evidence' | 'measurements' | 'visual' | 'plan' | 'history')[]
  /** 上下文预算，超出时按 history → 低危 finding → 非相关网络 → 器件参数 顺序裁剪 */
  budgetTokens: number
  /** 输出是否为结构化 JSON；general_chat 走纯文本 */
  structured: boolean
}

export const SKILLS: Record<AgentIntent, SkillSpec> = {
  design_review: {
    intent: 'design_review',
    slices: ['designDigest', 'evidence'],
    budgetTokens: 6000,
    structured: true,
  },
  measure_guide: {
    intent: 'measure_guide',
    slices: ['designDigest', 'plan'],
    budgetTokens: 4000,
    structured: true,
  },
  waveform_analyze: {
    intent: 'waveform_analyze',
    slices: ['designDigest', 'measurements', 'evidence'],
    budgetTokens: 5000,
    structured: true,
  },
  fault_diagnose: {
    intent: 'fault_diagnose',
    slices: ['designDigest', 'evidence', 'measurements', 'visual', 'plan'],
    budgetTokens: 12000,
    structured: true,
  },
  photo_analyze: {
    intent: 'photo_analyze',
    slices: ['visual', 'designDigest'],
    budgetTokens: 4000,
    structured: true,
  },
  report_generate: {
    intent: 'report_generate',
    slices: ['designDigest', 'evidence', 'measurements', 'visual', 'plan'],
    budgetTokens: 20000,
    structured: true,
  },
  general_chat: {
    intent: 'general_chat',
    slices: ['designDigest', 'history'],
    budgetTokens: 3000,
    structured: false,
  },
}
