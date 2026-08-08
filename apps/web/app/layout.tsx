import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Board Debug Copilot',
  description: '板级调试智能体 — 设计上下文 + 器件知识 + 测量数据 + 视觉信息',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-canvas text-slate-900 antialiased">{children}</body>
    </html>
  )
}
