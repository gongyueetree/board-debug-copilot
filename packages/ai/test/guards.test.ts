import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { dedupe, droppedRate, emptyStats, extractJson, ground, validate } from '../src'
import type { Finding } from '@app/contracts'

const finding = (over: Partial<Finding> = {}): Finding => ({
  code: 'GAIN_MISMATCH',
  origin: 'AI',
  severity: 'CRITICAL',
  title: '增益不符',
  description: '实测与期望不符',
  evidence: ['期望 10，实测 5.00'],
  risk: '',
  suggestion: '',
  resolved: false,
  ...over,
})

describe('extractJson', () => {
  it('去掉 markdown 围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('忽略 JSON 前后的解释文字', () => {
    expect(extractJson('这是结果：\n{"a":1}\n以上。')).toEqual({ a: 1 })
  })

  it('取首个平衡的对象，嵌套不误判', () => {
    expect(extractJson('{"a":{"b":[1,2]},"c":"}"}')).toEqual({ a: { b: [1, 2] }, c: '}' })
  })

  it('数组也能取', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('截断的 JSON 报括号不平衡而不是静默返回空', () => {
    expect(() => extractJson('{"a":{"b":1}')).toThrow(/不平衡|截断/)
  })

  it('完全没有 JSON 时抛出', () => {
    expect(() => extractJson('抱歉，我无法回答')).toThrow()
  })
})

describe('grounding 反幻觉', () => {
  const ctx = { componentRefs: new Set(['U1', 'R1']), netNames: new Set(['VOUT_AMP']) }

  it('丢弃不存在的位号', () => {
    const stats = emptyStats()
    const out = ground([finding({ componentRef: 'U99' })], ctx, stats)
    expect(out).toHaveLength(0)
    expect(stats.unknownRef).toBe(1)
  })

  it('丢弃不存在的网络', () => {
    const stats = emptyStats()
    expect(ground([finding({ netName: 'FAKE_NET' })], ctx, stats)).toHaveLength(0)
    expect(stats.unknownNet).toBe(1)
  })

  it('丢弃无数值也无位号的空泛证据', () => {
    const stats = emptyStats()
    const out = ground([finding({ evidence: ['可能存在一些问题', '建议检查一下'] })], ctx, stats)
    expect(out).toHaveLength(0)
    expect(stats.vagueEvidence).toBe(1)
  })

  it('保留证据具体且引用真实的条目', () => {
    const stats = emptyStats()
    expect(ground([finding({ componentRef: 'U1', netName: 'VOUT_AMP' })], ctx, stats)).toHaveLength(1)
  })

  it('droppedRate 反映丢弃比例', () => {
    const stats = emptyStats()
    ground([finding({ componentRef: 'U99' }), finding({ componentRef: 'U1' })], ctx, stats)
    expect(droppedRate(stats, 2)).toBe(0.5)
  })
})

describe('dedupe 保留优先级', () => {
  it('规则引擎结果胜过 AI，AI 描述并入补充', () => {
    const stats = emptyStats()
    const out = dedupe(
      [
        finding({ origin: 'AI', description: 'AI 的说法' }),
        finding({ origin: 'RULE_ENGINE', description: '规则引擎的说法' }),
      ],
      stats,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.origin).toBe('RULE_ENGINE')
    expect(out[0]!.description).toContain('规则引擎的说法')
    expect(out[0]!.description).toContain('AI 补充')
    expect(stats.duplicate).toBe(1)
  })

  it('位号不同不算重复', () => {
    const out = dedupe(
      [finding({ componentRef: 'U1' }), finding({ componentRef: 'R1' })],
      emptyStats(),
    )
    expect(out).toHaveLength(2)
  })
})

describe('validate', () => {
  const S = z.object({ a: z.number() })

  it('通过时返回解析值', () => {
    const r = validate(S, { a: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.a).toBe(1)
  })

  it('失败时给出可回灌给模型的字段说明', () => {
    const r = validate(S, { a: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues).toContain('a')
  })
})
