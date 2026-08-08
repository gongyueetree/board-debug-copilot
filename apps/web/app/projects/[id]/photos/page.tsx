import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="PCB 照片"
      phase="P5"
      spec="docs/03 页面 4"
      points={[
        '照片查看器（Konva：缩放旋转框选标注）+ KiCad 设计视图对照',
        '对齐与映射状态三卡（板框对齐 / 参考点 / 元器件映射 98.2%）',
        '与元器件关联的备注表格',
        'AI 视觉检测结果列表（置信度 + 风险 pill，区分确定与疑似）',
      ]}
    />
  )
}
