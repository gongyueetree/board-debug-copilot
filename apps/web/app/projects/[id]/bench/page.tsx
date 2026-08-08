import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="调试工作台"
      phase="P4"
      spec="docs/03 页面 3"
      points={[
        '左 380px 接线指南 + 检查清单 + 信号源设置 + 3 个预设配置',
        '中间实时波形（Canvas 双通道）+ FFT（自实现 Hann 窗）+ 测量结果网格 + 仪器控制条',
        '右 380px AI 调试参谋（实时解读 / 可能原因 / 建议下一步 / 快捷操作）',
        '危险确认：幅度 > 5Vpp 或偏置 != 0 时二次确认（硬性原则 #6）',
      ]}
    />
  )
}
