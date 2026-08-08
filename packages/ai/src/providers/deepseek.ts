/**
 * DeepSeekProvider — OpenAI 兼容接口。
 * 同一个类也能用于任何 OpenAI 兼容端点，改 baseUrl 即可。
 */
import type { ChatMessage, ChatOptions, LlmProvider, VisionImage } from './base'
import { sseEvents } from './sse'

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek' as const

  constructor(
    private readonly apiKey: string,
    private readonly model = 'deepseek-chat',
    private readonly baseUrl = 'https://api.deepseek.com/v1',
  ) {}

  private async call(body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`DeepSeek ${res.status}: ${detail.slice(0, 300)}`)
    }
    return res
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const res = await this.call(
      {
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.2,
        max_tokens: opts?.maxTokens ?? 8192,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      },
      opts?.signal,
    )
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    const res = await this.call(
      {
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.2,
        max_tokens: opts?.maxTokens ?? 4096,
        stream: true,
      },
      opts?.signal,
    )
    if (!res.body) throw new Error('DeepSeek 流式响应无 body')

    for await (const ev of sseEvents(res.body)) {
      if (!ev.data || ev.data === '[DONE]') continue
      try {
        const delta = JSON.parse(ev.data).choices?.[0]?.delta?.content
        if (delta) yield delta as string
      } catch {
        /* 忽略单个事件 */
      }
    }
  }

  async vision(_images: VisionImage[], prompt: string): Promise<string> {
    // deepseek-chat 无多模态；调用方应在 MOCK_MODE 或切到支持视觉的 provider
    throw new Error(
      `DeepSeek 当前模型不支持多模态输入（问题：${prompt.slice(0, 40)}…）。` +
        '请把 LLM_PROVIDER 切到 gemini 或 claude，或设 MOCK_MODE=true。',
    )
  }
}
