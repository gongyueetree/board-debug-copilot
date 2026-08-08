import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="调试计划"
      phase="P6"
      spec="docs/03 页面 5"
      points={[
        '问题描述横幅（currentIssue + 目标）',
        '左 55% 调试流程树（5 分组 22 步，工具列与耗时列）',
        '右 45% 步骤详情（操作目标 / 连接与设置 / 目标网点 / 预期参考值 / 异常与下一步）',
        '「开始测量」携带 setupJson 跳转工作台并预填仪器参数',
      ]}
    />
  )
}
