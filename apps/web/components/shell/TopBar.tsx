/**
 * 顶栏 — docs/03「全局 Shell」
 * Logo | 项目切换 | 设备状态 | 全局 AI 搜索 | 文档 | 通知 | 头像
 * P4 起设备状态联动 Bridge /status，P3 起搜索框接 Ctrl+K 命令面板。
 */
export function TopBar({ projectName }: { projectName: string }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 bg-topbar px-4 text-slate-100">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold">
          BD
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Board Debug Copilot</div>
          <div className="text-[10px] text-slate-400">准 LabSight</div>
        </div>
      </div>

      <div className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">{projectName}</div>

      <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm">
        <span className="h-2 w-2 rounded-full bg-slate-500" />
        <span className="text-slate-300">ADALM2000 未连接</span>
      </div>

      <div className="ml-auto hidden min-w-[280px] max-w-md flex-1 items-center rounded-lg bg-white/10 px-3 py-1.5 text-sm text-slate-400 md:flex">
        问 AI 助手（按 Ctrl + K）
      </div>

      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold">
        ZH
      </div>
    </header>
  )
}
