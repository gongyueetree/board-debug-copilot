/**
 * @app/kicad — 工程解析与原理图规则引擎
 *
 * P3 落地：rules（10 条原理图规则）+ graph（拓扑识别与 DesignDigest）。
 * parser/cli 待接真实 kicad-cli；MOCK_MODE 下设计图直接来自数据库。
 */
export {
  SCHEMATIC_RULES,
  runSchematicRules,
  parseValue,
} from './rules/schematic-rules'
export { finding, type DesignGraph, type SchematicRule } from './rules/types'
export { buildDesignDigest, detectOpampTopology, type DigestInput } from './graph/digest'

export const KICAD_PACKAGE_VERSION = '0.1.0'
