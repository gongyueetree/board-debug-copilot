import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="设计审查"
      phase="P3"
      spec="docs/03 页面 2"
      points={[
        '左 260px 组件与筛选（类别复选树 + 已选组件详情卡）',
        '中间原理图查看器（缩放平移、选中描边、网络高亮开关）',
        '右 360px AI 设计审查面板（风险卡片流 + BOM/ERC 小结卡）',
        'AI 通道：POST /ai/design-review 与 SSE /ai/chat，输出过 DesignReviewSchema',
      ]}
    />
  )
}
