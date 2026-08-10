import type { PartCategory } from '../types'

/**
 * 远端类目 → 内部枚举。
 *
 * 远端类目很可能是中文，也很可能是一棵多层的树。**这张表是参考文件落地处之一** ——
 * 拿到类目字典后把它补全，不要靠关键词猜。
 *
 * 现在的实现是关键词兜底：认得出的映射，认不出的落 OTHER。
 * OTHER 的参数白名单是空的，所以不会产出编造的参数 —— 这是有意的失败方式。
 */
const KEYWORDS: [RegExp, PartCategory][] = [
  [/运算放大|运放|op[\s-]?amp|operational amplifier/i, 'OPAMP'],
  [/低压差|ldo|linear regulator/i, 'LDO'],
  [/dc[\s-]?dc|switching regulator|buck|boost/i, 'DCDC'],
  [/模数转换|adc\b|analog[\s-]to[\s-]digital/i, 'ADC'],
  [/数模转换|\bdac\b|digital[\s-]to[\s-]analog/i, 'DAC'],
  [/单片机|微控制器|\bmcu\b|microcontroller/i, 'MCU'],
  [/\bfpga\b|cpld/i, 'FPGA'],
  [/存储器|memory|\beeprom\b|\bflash\b|\bsram\b/i, 'MEMORY'],
  [/电阻|resistor/i, 'RESISTOR'],
  [/电容|capacitor/i, 'CAPACITOR'],
  [/电感|inductor/i, 'INDUCTOR'],
  [/发光二极管|\bled\b/i, 'LED'],
  [/二极管|diode|schottky|tvs/i, 'DIODE'],
  [/场效应|\bmosfet\b|\bfet\b/i, 'MOSFET'],
  [/三极管|晶体管|\bbjt\b|transistor/i, 'BJT'],
  [/晶振|谐振|crystal|oscillator/i, 'CRYSTAL'],
  [/连接器|接插件|connector|header/i, 'CONNECTOR'],
  [/传感器|sensor/i, 'SENSOR'],
  [/收发器|transceiver|\bphy\b/i, 'TRANSCEIVER'],
]

/** TODO(参考文件)：拿到远端类目字典后，把精确映射填进这里，优先于关键词 */
export const EXPLICIT_CATEGORY_MAP: Record<string, PartCategory> = {}

export function mapCategory(remote?: string | null): PartCategory {
  if (!remote) return 'OTHER'
  const exact = EXPLICIT_CATEGORY_MAP[remote.trim()]
  if (exact) return exact
  for (const [re, cat] of KEYWORDS) if (re.test(remote)) return cat
  return 'OTHER'
}

/**
 * 从 KiCad 的 symbol / footprint / value 猜类目。
 *
 * 只在远端查不到器件时用 —— 位号首字母是最可靠的信号（R/C/L/D/Q/U/J），
 * 但 U 什么都可能是，所以 U 开头的一律 OTHER 而不是瞎猜成 OPAMP。
 */
export function guessCategoryFromRef(ref: string): PartCategory {
  const head = /^([A-Za-z]+)/.exec(ref)?.[1]?.toUpperCase() ?? ''
  const byRef: Record<string, PartCategory> = {
    R: 'RESISTOR', RN: 'RESISTOR',
    C: 'CAPACITOR', CN: 'CAPACITOR',
    L: 'INDUCTOR', FB: 'INDUCTOR',
    D: 'DIODE', LED: 'LED', Q: 'MOSFET',
    Y: 'CRYSTAL', X: 'CRYSTAL',
    J: 'CONNECTOR', P: 'CONNECTOR', CN2: 'CONNECTOR',
    TP: 'OTHER',
  }
  return byRef[head] ?? 'OTHER'
}
