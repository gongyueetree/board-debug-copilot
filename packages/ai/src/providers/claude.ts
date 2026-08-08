/**
 * ClaudeProvider — Anthropic Messages API。
 * 同样走 fetch，SDK import 只允许出现在 providers/ 下。
 */
import type { ChatMessage, ChatOptions, LlmProvider, VisionImage } from './base'
import { sseEvents } from './sse'

const BASE = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'

/** Anthropic 的 system 是顶层参数，不是 messages 里的一条 */
function toBody(messages: ChatMessage[], opts: ChatOptions | undefined, stream: boolean) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  return {
    model: opts?.model ?? 'claude-sonnet-4-6',
    max_tokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0.2,
    ...(system ? { system } : {}),
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
    ...(stream ? { stream: true } : {}),
  }
}

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude' as const

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-sonnet-4-6',
  ) {}

  private async call(body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': VERSION,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Claude ${res.status}: ${detail.slice(0, 300)}`)
    }
    return res
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const res = await this.call({ ...toBody(messages, opts, false), model: this.model }, opts?.signal)
    const data = (await res.json()) as { content?: { type: string; text?: string }[] }
    return (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }

  async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    const res = await this.call({ ...toBody(messages, opts, true), model: this.model }, opts?.signal)
    if (!res.body) throw new Error('Claude 流式响应无 body')

    for await (const ev of sseEvents(res.body)) {
      if (!ev.data) continue
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
          yield msg.delta.text as string
        }
      } catch {
        /* 忽略单个事件 */
      }
    }
  }

  async vision(images: VisionImage[], prompt: string, opts?: ChatOptions): Promise<string> {
    const res = await this.call(
      {
        model: this.model,
        max_tokens: opts?.maxTokens ?? 4096,
        messages: [
          {
            role: 'user',
            content: [
              ...images.map((img) => ({
                type: 'image',
                source: { type: 'base64', media_type: img.mimeType, data: img.data },
              })),
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      opts?.signal,
    )
    const data = (await res.json()) as { content?: { type: string; text?: string }[] }
    return (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }
}
