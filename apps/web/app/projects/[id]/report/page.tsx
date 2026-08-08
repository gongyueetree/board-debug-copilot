import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="测试报告"
      phase="P7"
      spec="docs/03 页面 6"
      points={[
        '左 240px 报告目录（7 章树 + 自定义章节）',
        '中间 A4 纸样预览（markdown + 结构化数据渲染）',
        '右 320px 报告设置（标题/作者/版本/封面 + 导出选项 + AI 报告摘要）',
        'MVP 仅 Markdown 可导出，PDF/DOCX 显示即将支持',
      ]}
    />
  )
}
