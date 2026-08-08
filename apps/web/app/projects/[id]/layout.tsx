import { SideNav } from '@/components/shell/SideNav'
import { TopBar } from '@/components/shell/TopBar'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <div className="flex h-screen flex-col">
      <TopBar projectName="Sensor Board Debug Demo" />
      <div className="flex min-h-0 flex-1">
        <SideNav projectId={id} />
        <main className="min-w-0 flex-1 overflow-auto bg-canvas p-6">{children}</main>
      </div>
    </div>
  )
}
