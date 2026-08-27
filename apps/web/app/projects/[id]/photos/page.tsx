import { AssemblyInspectionPanel } from '@/components/photo/AssemblyInspectionPanel'
import { CameraCapturePanel } from '@/components/photo/CameraCapturePanel'
import { PhotosClient } from '@/components/photo/PhotosClient'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export const dynamic = 'force-dynamic'

export default async function PhotosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const photos = await prefetch(() => api.photos(id))
  const currentPhoto = photos?.[0]

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">PCB 照片 / 实时视觉</h1>
        <p className="mt-1 text-sm text-slate-500">
          直接连接 Insta360 / UVC 或 Seeed reCamera Pro，抓取高清 PCB 画面并结合 KiCad footprint / pad 分组做装配与视觉检查
        </p>
      </header>
      <div className="space-y-4">
        <CameraCapturePanel projectId={id} />
        {currentPhoto && <AssemblyInspectionPanel photoId={currentPhoto.id} />}
        <PhotosClient projectId={id} initial={photos} />
      </div>
    </div>
  )
}
