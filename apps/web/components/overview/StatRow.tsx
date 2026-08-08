import { StatCard } from '@app/ui'
import type { ProjectDetail } from '@/lib/api'

const CheckIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.3a1 1 0 00-1.4-1.4L9 10.6 7.7 9.3a1 1 0 10-1.4 1.4l2 2a1 1 0 001.4 0l4-4z"
      clipRule="evenodd"
    />
  </svg>
)
const ShieldIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M10 1.6l6 2.4v5c0 4-2.6 7.6-6 9.4-3.4-1.8-6-5.4-6-9.4v-5l6-2.4zM9 7v4h2V7H9zm0 6v2h2v-2H9z"
      clipRule="evenodd"
    />
  </svg>
)
const WaveIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M2 12c2 0 2-5 4-5s2 5 4 5 2-5 4-5 2 5 4 5" strokeLinecap="round" />
  </svg>
)
const SparkIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
    <path d="M10 1l1.8 4.6L16.5 7l-4.7 1.4L10 13l-1.8-4.6L3.5 7l4.7-1.4L10 1zM15.5 12l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z" />
  </svg>
)

/** 顶部 4 张统计卡（docs/03 页面 1） */
export function StatRow({ project }: { project: ProjectDetail }) {
  const s = project.stats
  const sev = s.violationsBySeverity
  const parsedAt = new Date(project.updatedAt).toLocaleString('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={<CheckIcon />}
        tone="green"
        label="工程解析完成"
        value="原理图、PCB、BOM 已解析"
        variant="text"
        sub={parsedAt}
        pill="完成"
      />
      <StatCard
        icon={<ShieldIcon />}
        tone="orange"
        label="ERC/DRC 风险"
        value={s.openViolations}
        sub={`高风险 ${sev.CRITICAL} · 中风险 ${sev.WARNING} · 低风险 ${sev.INFO}`}
        pill="需关注"
      />
      <StatCard
        icon={<WaveIcon />}
        tone="blue"
        label="最近测量"
        value={s.captures}
        sub="波形捕获"
        pill="本次会话"
      />
      <StatCard
        icon={<SparkIcon />}
        tone="violet"
        label="AI 建议"
        value={s.aiSuggestions}
        sub="待处理建议"
        pill={`${s.debugSteps.completed}/${s.debugSteps.total} 步完成`}
      />
    </div>
  )
}
