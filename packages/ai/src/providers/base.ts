/**
 * L0 Provider 适配层 — 应用代码禁止直接 import 任何 LLM SDK。
 * 规格见 docs/05-agent-design.md §2。
 */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOptions {
  /** 0 表示确定性输出，路由分类固定用 0 */
  temperature?: number
  maxTokens?: number
  /** 覆盖 provider 默认模型 */
  model?: string
  /** 供 mock provider 查表，以及可观测性打点 */
  intent?: string
  scenario?: string
  signal?: AbortSignal
}

export interface VisionImage {
  /** base64（不含 data: 前缀） */
  data: string
  mimeType: string
}

export type ProviderName = 'claude' | 'deepseek' | 'gemini' | 'mock'

export interface LlmProvider {
  readonly name: ProviderName
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
  chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string>
  vision(images: VisionImage[], prompt: string, opts?: ChatOptions): Promise<string>
}
