/**
 * L5 编排：把「调 provider → 抠 JSON → schema 校验 → 失败修复一次 → 返回」
 * 收敛成一个函数，所有技能共用。
 *
 * docs/05 §9：schema 校验失败允许把 zod issue 回灌给模型修复一次，仅一次。
 */
import type { z } from 'zod'
import type { ChatMessage, ChatOptions, LlmProvider } from '../providers/base'
import { extractJson, validate } from '../guards'

export interface StructuredRunResult<T> {
  ok: boolean
  value: T | null
  /** 供 UI 展示与可观测性 */
  raw: string
  repaired: boolean
  error?: string
}

export async function runStructured<S extends z.ZodTypeAny>(
  provider: LlmProvider,
  schema: S,
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<StructuredRunResult<z.infer<S>>> {
  let raw = ''
  try {
    raw = await provider.chat(messages, { ...opts, json: true })
  } catch (err) {
    return { ok: false, value: null, raw: '', repaired: false, error: (err as Error).message }
  }

  const attempt = (text: string) => {
    try {
      return validate(schema, extractJson(text))
    } catch (err) {
      return { ok: false as const, issues: (err as Error).message }
    }
  }

  const first = attempt(raw)
  if (first.ok) return { ok: true, value: first.value, raw, repaired: false }

  // 只修复一次，避免延迟翻倍
  try {
    const repairedRaw = await provider.chat(
      [
        ...messages,
        { role: 'assistant', content: raw.slice(0, 4000) },
        {
          role: 'user',
          content: `上一次输出不符合 schema：${first.issues}\n请只输出修正后的完整 JSON，不要任何解释文字。`,
        },
      ],
      { ...opts, temperature: 0, json: true },
    )
    const second = attempt(repairedRaw)
    if (second.ok) {
      return { ok: true, value: second.value, raw: repairedRaw, repaired: true }
    }
    return {
      ok: false,
      value: null,
      raw: repairedRaw,
      repaired: true,
      error: `二次校验仍失败：${second.issues}`,
    }
  } catch (err) {
    return { ok: false, value: null, raw, repaired: true, error: (err as Error).message }
  }
}
