import { PhotosClient } from '@/components/photo/PhotosClient'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function PhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const photos = await prefetch(() => api.photos(id))

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">PCB 照片</h1>
        <p className="mt-1 text-sm text-slate-500">
          上传 PCB 实物照片，AI 识别并与原理图 / PCB 设计对比分析
        </p>
      </header>
      <PhotosClient projectId={id} initial={photos} />
    </div>
  )
}
