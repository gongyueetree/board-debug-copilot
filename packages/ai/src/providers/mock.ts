/**
 * MockProvider — 确定性演示与评测基线。
 *
 * docs/05 §11.2：同一 (intent, scenario, projectId) 永远返回同一结果，不得引入随机数。
 * P3 接入按 (intent, scenario) 查表的预置结果；P0 只保证接口可用与流式节奏真实。
 */
import type { ChatMessage, ChatOptions, LlmProvider, VisionImage } from './base'

const CHARS_PER_SECOND = 30

export class MockProvider implements LlmProvider {
  readonly name = 'mock' as const

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    return this.canned(messages, opts)
  }

  async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    const text = this.canned(messages, opts)
    const delayMs = Math.round(1000 / CHARS_PER_SECOND)
    for (const ch of text) {
      if (opts?.signal?.aborted) return
      await new Promise((r) => setTimeout(r, delayMs))
      yield ch
    }
  }

  async vision(images: VisionImage[], prompt: string): Promise<string> {
    return `[mock vision] ${images.length} 张图片，问题：${prompt}`
  }

  private canned(messages: ChatMessage[], opts?: ChatOptions): string {
    const last = messages.at(-1)?.content ?? ''
    const intent = opts?.intent ?? 'general_chat'
    const scenario = opts?.scenario ?? 'gain_error'
    return [
      `[mock provider] intent=${intent} scenario=${scenario}`,
      `收到 ${messages.length} 条消息，最后一条前 40 字：${last.slice(0, 40)}`,
      'P3 起由 packages/ai/src/skills 按 docs/05 §11.1 返回预置结构化结果。',
    ].join('\n')
  }
}
