/** 左侧导航，顺序对齐 docs/03「全局 Shell」 */
export const DEMO_PROJECT_ID = '00000000-0000-0000-0000-0000000000d1'

export interface NavItem {
  label: string
  href: string
  phase: string
}

export function navItems(projectId: string): NavItem[] {
  const base = `/projects/${projectId}`
  return [
    { label: '项目总览', href: base, phase: 'P2' },
    { label: '设计审查', href: `${base}/design`, phase: 'P3' },
    { label: '调试工作台', href: `${base}/bench`, phase: 'P4' },
    { label: 'PCB照片', href: `${base}/photos`, phase: 'P5' },
    { label: '调试计划', href: `${base}/plan`, phase: 'P6' },
    { label: '测试报告', href: `${base}/report`, phase: 'P7' },
    { label: '元器件库', href: `${base}/parts`, phase: 'P8' },
  ]
}
