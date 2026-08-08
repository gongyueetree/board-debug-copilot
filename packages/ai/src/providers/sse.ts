/**
 * SSE 流解析。
 *
 * 三个 provider 共用，因为换行约定并不统一：Gemini 用 CRLF（\r\n\r\n）分隔事件，
 * 按 \n\n 切会一个事件都切不出来 —— 表现为流式「成功」但一个 token 都没吐。
 * 这里统一按 /\r?\n\r?\n/ 切，行尾 \r 由 trim 处理。
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<{ event: string | null; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const chunks = buffer.split(/\r?\n\r?\n/)
      // 最后一段可能是半个事件，留到下一轮
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        let event: string | null = null
        const data: string[] = []
        for (const rawLine of chunk.split(/\r?\n/)) {
          const line = rawLine.trimEnd()
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trim())
        }
        if (data.length > 0) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
