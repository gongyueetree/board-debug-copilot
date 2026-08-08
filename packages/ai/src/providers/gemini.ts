/**
 * GeminiProvider — Google Generative Language REST API。
 *
 * 用 fetch 而不是 SDK：适配层只需要三个方法，引 SDK 会把版本变动引进来，
 * 而 REST 的 generateContent / streamGenerateContent 接口是稳定的。
 * SDK import 只允许出现在 providers/ 下（CLAUDE.md：应用代码禁止直连 LLM SDK）。
 */
import type { ChatMessage, ChatOptions, LlmProvider, VisionImage } from './base'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiPart {
  text?: string
  inline_data?: { mime_type: string; data: string }
}

/** Gemini 把 system 单独放 systemInstruction，且只认 user/model 两种 role */
function toGeminiBody(messages: ChatMessage[], opts?: ChatOptions) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }] as GeminiPart[],
    }))

  return {
    contents,
    ...(system.length > 0
      ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } }
      : {}),
    generationConfig: {
      temperature: opts?.temperature ?? 0.2,
      maxOutputTokens: opts?.maxTokens ?? 4096,
    },
  }
}

function extractText(payload: unknown): string {
  const parts =
    (payload as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]
      ?.content?.parts ?? []
  return parts.map((p) => p.text ?? '').join('')
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const

  constructor(
    private readonly apiKey: string,
    private readonly model = 'gemini-2.5-flash',
    private readonly visionModel = 'gemini-2.5-flash',
  ) {}

  private async call(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`)
    }
    return res
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const res = await this.call(
      `models/${this.model}:generateContent`,
      toGeminiBody(messages, opts),
      opts?.signal,
    )
    return extractText(await res.json())
  }

  async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    const res = await this.call(
      `models/${this.model}:streamGenerateContent?alt=sse`,
      toGeminiBody(messages, opts),
      opts?.signal,
    )
    if (!res.body) throw new Error('Gemini 流式响应无 body')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件；半个事件留在 buffer 里等下一块
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''

      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        const json = line.slice(5).trim()
        if (!json || json === '[DONE]') continue
        try {
          const delta = extractText(JSON.parse(json))
          if (delta) yield delta
        } catch {
          /* 单个事件解析失败不中断整个流 */
        }
      }
    }
  }

  async vision(images: VisionImage[], prompt: string, opts?: ChatOptions): Promise<string> {
    const parts: GeminiPart[] = [
      ...images.map((img) => ({
        inline_data: { mime_type: img.mimeType, data: img.data },
      })),
      { text: prompt },
    ]

    const res = await this.call(
      `models/${this.visionModel}:generateContent`,
      {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: opts?.temperature ?? 0.2,
          maxOutputTokens: opts?.maxTokens ?? 4096,
        },
      },
      opts?.signal,
    )
    return extractText(await res.json())
  }
}
