/**
 * @app/kicad — 工程解析与原理图规则引擎
 *
 * rules   原理图规则（确定性，先于 LLM）
 * graph   拓扑识别与 DesignDigest
 * cli     kicad-cli adapter，失败降级 mock 不崩项目
 * parser  netlist / PCB S-expr 解析
 */
export { SCHEMATIC_RULES, runSchematicRules, parseValue } from './rules/schematic-rules'
export { finding, type DesignGraph, type SchematicRule } from './rules/types'
export { buildDesignDigest, detectOpampTopology, type DigestInput } from './graph/digest'
export {
  collectSvgArtifacts,
  parseProject,
  probeKicadCli,
  type KicadCliOptions,
  type ParseOutcome,
  type ParseStep,
} from './cli/adapter'
export {
  inferCategory,
  inferNetRole,
  inferPinType,
  parseNetlist,
  parseSExpr,
} from './parser/netlist'
export {
  parsePcbAssembly,
  assemblyPromptTable,
  type AssemblyPad,
  type AssemblyFootprint,
  type PcbAssemblyMap,
} from './parser/pcb-assembly'
export {
  computeHomography,
  projectPoint,
  generateFootprintRois,
  type Point2D,
  type Homography,
  type FootprintGeometry,
  type FootprintRoi,
} from './geometry/registration'

export {
  parseKicadArchive,
  pickRoot,
  type ArchiveDeps,
  type ArchiveOutcome,
  type StorageLike,
} from './archive/parse-archive'
export {
  DEFAULT_LIMITS,
  checkEntryPath,
  safeUnzip,
  type UnzipLimits,
  type UnzipResult,
} from './archive/safe-unzip'
export {
  extractRefs,
  normalizeCode,
  normalizeSeverity,
  parseErcDrc,
  parseErcDrcJson,
  parseErcDrcText,
} from './parser/erc-drc'

export const KICAD_PACKAGE_VERSION = '0.5.0'
