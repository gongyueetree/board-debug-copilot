/**
 * @app/kicad — 工程解析与原理图规则引擎
 *
 * P3 落地：
 *   src/parser/  mock parser（读 seed，不解析真实文件），后接 kicad-cli
 *   src/cli/     kicad-cli 调用与失败降级（失败写 parseLog，不让项目崩溃）
 *   src/graph/   网表邻接与拓扑识别，产出 docs/05 §4.2 的 [TOPOLOGY] 段
 *   src/rules/   原理图 10 条规则，输出 RuleViolation
 *
 * 规则 code 词表见 docs/05 §5.2（原理图族）。
 */

export const SCHEMATIC_RULE_CODES = [
  'POWER_NET_MISSING',
  'GND_NET_MISSING',
  'SINGLE_PIN_NET',
  'FLOATING_INPUT',
  'OPAMP_FEEDBACK_SUSPECT',
  'OPEN_DRAIN_NO_PULLUP',
  'I2C_PULLUP_MISSING',
  'DECOUPLING_INSUFFICIENT',
  'LDO_CAP_MISSING',
  'RESET_PIN_FLOATING',
  'CONNECTOR_UNPROTECTED',
] as const

export type SchematicRuleCode = (typeof SCHEMATIC_RULE_CODES)[number]

export const KICAD_PACKAGE_VERSION = '0.1.0'
