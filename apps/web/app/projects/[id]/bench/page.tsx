import { BenchClient } from '@/components/bench/BenchClient'

export const dynamic = 'force-dynamic'

export default async function BenchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  return (
    <div className="mx-auto max-w-[1800px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">调试工作台</h1>
        <p className="mt-1 text-sm text-slate-500">
          浏览器直连本机 Bridge 采集波形，云端不经手 USB 设备
        </p>
      </header>
      <BenchClient projectId={id} />
    </div>
  )
}
