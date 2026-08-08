import type { Finding, Severity } from '@app/contracts'

/** 规则引擎的输入：从 DB 读出的设计图，不依赖 Prisma 类型 */
export interface DesignGraph {
  components: {
    ref: string
    value: string | null
    category: string | null
    partNumber: string | null
    /** rawJson 里的自由字段，规则用它读器件参数 */
    meta: Record<string, unknown>
    pins: { number: string; name: string | null; type: string | null; netName: string | null }[]
  }[]
  nets: {
    name: string
    inferredRole: string | null
    expectedVoltage: string | null
    pinRefs: { componentRef: string; pinNumber: string; pinName: string | null }[]
  }[]
}

export interface SchematicRule {
  code: Finding['code']
  title: string
  severity: Severity
  run(graph: DesignGraph): Omit<Finding, 'origin'>[]
}

export function finding(
  code: Finding['code'],
  severity: Severity,
  title: string,
  fields: {
    description: string
    evidence: string[]
    risk: string
    suggestion: string
    recommendedTest?: string
    componentRef?: string
    netName?: string
  },
): Omit<Finding, 'origin'> {
  return { code, severity, title, resolved: false, ...fields }
}
