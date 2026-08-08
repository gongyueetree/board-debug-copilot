import { QueryProvider } from '@/components/QueryProvider'
import { SideNav } from '@/components/shell/SideNav'
import { TopBar } from '@/components/shell/TopBar'
import { api } from '@/lib/api'
import { prefetch } from '@/lib/server-fetch'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const projects = (await prefetch(() => api.projects())) ?? []

  return (
    <QueryProvider>
      <div className="flex h-screen flex-col">
        <TopBar projects={projects} currentId={id} />
        <div className="flex min-h-0 flex-1">
          <SideNav projectId={id} />
          <main className="min-w-0 flex-1 overflow-auto bg-canvas p-6">{children}</main>
        </div>
      </div>
    </QueryProvider>
  )
}
