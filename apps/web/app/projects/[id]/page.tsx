import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="项目总览"
      phase="P2"
      spec="docs/03 页面 1"
      points={[
        '顶部 4 张统计卡：工程解析完成 / ERC-DRC 风险 12 / 最近测量 8 / AI 建议 5',
        '设计概览卡（Schematic/PCB/BOM 三 tab + 关键器件与关键网络）',
        '最近测试波形卡（CH1 绿 / CH2 橙 双通道 + 测量数字行）',
        'AI 调试参谋卡（可能问题 / 关键证据 / 推荐下一步 + 生成调试步骤）',
        '高风险问题列表 / 最近调试记录时间线 / PCB 实物照片卡',
      ]}
    />
  )
}
