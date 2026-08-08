'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@app/ui'
import { navItems } from '@/lib/nav'

export function SideNav({ projectId }: { projectId: string }) {
  const pathname = usePathname()
  const items = navItems(projectId)

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-slate-200 bg-white py-3">
      {items.map((item) => {
        const active = pathname === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'mx-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50',
              active && 'bg-blue-50 font-medium text-brand hover:bg-blue-50',
            )}
          >
            {item.label}
          </Link>
        )
      })}
      <div className="mt-auto mx-2 rounded-lg px-3 py-2 text-sm text-slate-400">设置</div>
    </nav>
  )
}
