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

/**
 * 从 MPN 前缀 + 描述 + 符号名推断类目。
 *
 * ezPLM **不返回 category 字段**，而 `PARAM_WHITELIST` 是按类目抽参数的 ——
 * 没有类目就一个参数都抽不出来。所以退到推断。
 *
 * 推不出来落 `OTHER`，`OTHER` 的白名单是空的：**认不出就不抽参数，
 * 而不是抽错参数**。抽错的 vsAbsMax 比抽不到危险得多。
 */
const MPN_PREFIX: [RegExp, PartCategory][] = [
  // 运放：ADI / TI / Microchip 的常见系列
  [/^(AD8|ADA4|OPA|OP\d|LM3(58|24)|TLV\d|MCP6|LT1\d{3})/i, 'OPAMP'],
  // LDO
  [/^(TPS7|LP\d{4}|LM11\d{2}|MIC5\d{3}|AMS1117|XC6\d{3}|RT9\d{3})/i, 'LDO'],
  // 开关电源
  [/^(TPS5|TPS6|LM2\d{3}|MP\d{4}|LMR\d{3}|AOZ\d{4})/i, 'DCDC'],
  [/^(ADS1|ADS8|MCP3\d{3}|ADC\d)/i, 'ADC'],
  [/^(MCP4\d{3}|DAC\d|AD56)/i, 'DAC'],
  [/^(STM32|GD32|ESP32|ATMEGA|ATSAM|NRF5|RP2\d{3}|PIC\d{2})/i, 'MCU'],
  [/^(W25Q|AT24C|24LC|MX25|IS4\d)/i, 'MEMORY'],
  [/^(SN65|MAX48|MAX32\d\d|ADM3|TJA1)/i, 'TRANSCEIVER'],
]

export function inferCategory(input: {
  mpn?: string
  description?: string
  symbol?: string
}): PartCategory {
  const mpn = (input.mpn ?? '').trim()
  for (const [re, cat] of MPN_PREFIX) if (re.test(mpn)) return cat

  // 描述与符号名走关键词表（中英文都认）
  for (const text of [input.description, input.symbol]) {
    if (!text) continue
    const byKeyword = mapCategory(text)
    if (byKeyword !== 'OTHER') return byKeyword
  }
  return 'OTHER'
}
