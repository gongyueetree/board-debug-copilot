/**
 * 回调 api 内部端点。
 *
 * 纯 DB 聚合类任务（报告、BOM 匹配）不在 worker 里重写一遍：
 * 那会让 provider 配置、守卫管线、落库逻辑在两个进程各维护一份，
 * 迟早漂移。多一次 HTTP 跳转换单一实现，值得。
 *
 * 反过来，解压、跑 kicad-cli 这类文件系统重活必须留在 worker ——
 * 那正是不该发生在 API 请求生命周期里的事情。
 */
export async function callApi(
  path: string,
  body: unknown,
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const base = (process.env.API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.INTERNAL_TOKEN ? { 'x-internal-token': process.env.INTERNAL_TOKEN } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`api ${path} 返回 ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as Record<string, unknown>
}
