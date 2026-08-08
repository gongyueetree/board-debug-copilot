/**
 * 各技能的任务指令与输出 schema 描述。
 *
 * schema 用精简 JSON 骨架而不是完整 JSON Schema：真实模型对 200 行的
 * JSON Schema 遵循度反而不如一个带注释的示例骨架，且省 token。
 */

export const SCHEMA_HINTS = {
  design_review: `{
  "summary": "一句话总结，≤200字",
  "findings": [{
    "code": "受控词表中的枚举值",
    "severity": "CRITICAL|WARNING|INFO",
    "title": "≤30字",
    "description": "≤400字",
    "evidence": ["每条必须含具体数值或位号", "..."],
    "risk": "影响是什么",
    "suggestion": "怎么改",
    "recommendedTest": "怎么验证（可选）",
    "componentRef": "位号（可选，必须存在于上下文）",
    "netName": "网络名（可选，必须存在于上下文）",
    "resolved": false
  }]
}`,

  waveform_analyze: `{
  "severity": "CRITICAL|WARNING|INFO",
  "primaryCode": "本次测量中存在的故障 code：OUTPUT_CLIPPING|GAIN_MISMATCH|NO_RESPONSE|NOISE_EXCESSIVE|FREQ_MISMATCH|PHASE_MISMATCH|OFFSET_ABNORMAL|THDN_HIGH。本次测量正常时必须为 null，不要填写历史故障或设计缺陷的 code",
  "rootCause": "唯一根因，≤200字",
  "confidence": 0.0,
  "evidence": ["必须含期望值与实测值的对比", "..."],
  "alternativeCauses": [{"cause": "≤120字", "likelihood": 0.0}],
  "recommendations": [{
    "order": 1,
    "action": "≤120字，第一条必须能在5分钟内证伪当前根因",
    "detail": "可选",
    "targetComponent": "位号（可选）",
    "targetNet": "网络名（可选）"
  }]
}`,

  photo_analyze: `{
  "findings": [{
    "code": "SOLDER_BRIDGE|MISSING_PART|POLARITY|ORIENTATION|JOINT_QUALITY",
    "title": "≤30字",
    "detail": "≤300字",
    "confidence": 0.0,
    "severity": "高风险|中风险|低风险|正常",
    "componentRef": "位号（可选）",
    "certainty": "CONFIRMED|SUSPECTED"
  }]
}`,

  measure_guide: `{
  "mode": "SCOPE|DMM|AWG_SCOPE|FFT|LOGIC",
  "wiring": [{"from": "CH1+", "to": "TP1 (VIN_SENS)", "note": "可选"}],
  "range": "量程说明（可选）",
  "trigger": "触发说明（可选）",
  "requiresConfirm": false,
  "safetyNotes": ["安全提示"],
  "rationale": "为什么这么设时基与触发，≤200字",
  "expectedValue": {"value": "2.50", "unit": "V", "label": "直流电压"}
}`,

  report_generate: `{
  "summaryMd": "报告摘要段落，≤400字，只汇总已有事实",
  "conclusions": ["结论1", "结论2"],
  "nextActions": ["下一步1", "下一步2"]
}`,
} as const

export const TASK_PROMPTS = {
  design_review: '请补充规则引擎覆盖不到的设计推理问题。输出 JSON，不要输出 JSON 以外的文字。',
  waveform_analyze:
    '请分析本次测量。先从 [TOPOLOGY] 推导期望值再与实测比对，按「先削顶→再增益→再频率→再相位→最后噪声」的顺序判定。输出 JSON。',
  fault_diagnose:
    '请综合设计、测量、视觉三路证据给出唯一根因，至少两路互相印证才能给高置信度。输出 JSON。',
  photo_analyze:
    '请检查这张 PCB 照片的焊接与装配问题。不确定一律标 SUSPECTED，置信度低于 0.6 不得标 CONFIRMED。输出 JSON。',
  measure_guide: '请给出可执行的测量方案：仪器模式、逐条接线、量程与触发，并说明为什么。输出 JSON。',
  report_generate: '请基于已落库的事实生成报告摘要与结论，不得新增任何未在上下文中出现的结论。输出 JSON。',
} as const
