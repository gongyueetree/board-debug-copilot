import type { AgentIntent } from '@app/contracts'

/**
 * 三级路由（docs/05 §3），优先级从高到低，命中即停。
 * 前端每个页面固定传 mode，覆盖 90% 请求且零额外 LLM 调用。
 */
const KEYWORDS: [RegExp, AgentIntent][] = [
  [/接线|怎么测|如何测|设置仪器|量程|探头/, 'measure_guide'],
  [/波形|削顶|增益|相位|噪声|失真|THD|FFT|频谱/, 'waveform_analyze'],
  [/焊|照片|贴片|桥接|缺件|装配|极性/, 'photo_analyze'],
  [/报告|导出|总结文档/, 'report_generate'],
  [/原理图|设计|审查|风险|去耦|上拉|选型/, 'design_review'],
  [/根因|为什么|故障|诊断|排查/, 'fault_diagnose'],
]

export function routeIntent(input: { mode?: string; message?: string }): AgentIntent {
  // 1 显式 mode
  const explicit = input.mode as AgentIntent | undefined
  if (
    explicit &&
    [
      'design_review',
      'measure_guide',
      'waveform_analyze',
      'fault_diagnose',
      'photo_analyze',
      'report_generate',
      'general_chat',
    ].includes(explicit)
  ) {
    return explicit
  }

  // 2 关键词
  const msg = input.message ?? ''
  for (const [re, intent] of KEYWORDS) {
    if (re.test(msg)) return intent
  }

  // 3 LLM 分类留给 P8；当前降级为通用对话
  return 'general_chat'
}
