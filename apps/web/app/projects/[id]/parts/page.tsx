import { PagePlaceholder } from '@/components/PagePlaceholder'

export default function Page() {
  return (
    <PagePlaceholder
      title="元器件库"
      phase="P8"
      spec="docs/03 全局 Shell 导航"
      points={[
        '走 PartsDatabaseAdapter，MVP 用 mock，不假装有真实库存与价格',
        '为后续接入真实百万器件库预留检索接口（docs/05 §16.3 RAG 待决）',
      ]}
    />
  )
}
