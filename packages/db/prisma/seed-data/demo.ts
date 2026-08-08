/**
 * Sensor Board Debug Demo — 数据定义
 *
 * 数值权威来源：docs/02「Seed（必须实现）」+ docs/05 §11.1（五场景）/ §16.1、§16.2（决议）。
 * 电路：AD8605 反相放大器，单电源 5V，Rin=R3 10k，Rf=R1 100k，设计增益 -10，Vref 应为 2.5V。
 *
 * 故障叙事（跨模态收敛）：
 *   设计缺陷 U1.3 接 GND 而非 Vref  →  no_response（Vout≈0V，即 currentIssue）
 *   补 Vref 后输入过大             →  clipping（THD+N 28.2%，贴轨）
 *   降幅后仍增益减半               →  gain_error（R2 桥接使 Rf 等效 50k）← 默认场景
 *   清除桥接                       →  normal（Gain 9.98）
 */

export const PROJECT_ID = '00000000-0000-0000-0000-0000000000d1'
export const PHOTO_ID = '00000000-0000-0000-0000-0000000000f1'
export const REPORT_ID = '00000000-0000-0000-0000-0000000000e1'

export const NETS = [
  {
    name: 'VIN_SENS',
    inferredRole: 'SIGNAL',
    expectedVoltage: '0.400 Vpp (AC)',
    expectedFrequency: '1 kHz',
  },
  { name: 'U1_IN-', netClass: 'N0012', inferredRole: 'SIGNAL', expectedVoltage: '2.5 V (虚地)' },
  {
    name: 'VOUT_AMP',
    inferredRole: 'SIGNAL',
    expectedVoltage: '4.0 Vpp (AC)',
    expectedFrequency: '1 kHz',
  },
  { name: 'VREF', inferredRole: 'BIAS', expectedVoltage: '2.5 V' },
  { name: '+5V', inferredRole: 'POWER', expectedVoltage: '5.0 V' },
  { name: '3V3', inferredRole: 'POWER', expectedVoltage: '3.3 V' },
  { name: 'SDA', inferredRole: 'I2C', expectedVoltage: '3.3 V (开漏)' },
  { name: 'SCL', inferredRole: 'I2C', expectedVoltage: '3.3 V (开漏)' },
  { name: 'GND', inferredRole: 'GND', expectedVoltage: '0 V' },
] as const

/** pins: [引脚号, 引脚名, 类型, 网络名 | null] */
export const COMPONENTS = [
  {
    ref: 'U1',
    value: 'AD8605',
    partNumber: 'AD8605ARZ',
    manufacturer: 'Analog Devices',
    footprint: 'SOIC-8',
    symbol: 'Amplifier_Operational:AD8605',
    datasheetUrl: 'https://www.analog.com/media/en/technical-documentation/data-sheets/AD8605_8606_8608.pdf',
    x: 120,
    y: 80,
    side: 'TOP',
    rawJson: {
      category: '运算放大器',
      supplyRange: '2.7~5.5 V (absmax 6 V)',
      inputBiasCurrent: '1 pA',
      gbw: '10 MHz',
      output: 'rail-to-rail (±20 mV)',
      note: '单电源 5V 下最大输出摆幅约 4.96 Vpp',
    },
    pins: [
      ['1', 'OUT', 'output', 'VOUT_AMP'],
      ['2', 'IN-', 'input', 'U1_IN-'],
      ['3', 'IN+', 'input', 'GND'],
      ['4', 'V-', 'power_in', 'GND'],
      ['5', 'NC', 'no_connect', null],
      ['6', 'NC', 'no_connect', null],
      ['7', 'NC', 'no_connect', null],
      ['8', 'V+', 'power_in', '+5V'],
    ],
  },
  {
    ref: 'U2',
    value: 'MCP4725',
    partNumber: 'MCP4725A0T-E/CH',
    manufacturer: 'Microchip',
    footprint: 'SOT-23-6',
    x: 200,
    y: 150,
    side: 'TOP',
    rawJson: { category: 'DAC', interface: 'I2C', address: '0x60', resolution: '12-bit' },
    pins: [
      ['1', 'VOUT', 'output', null],
      ['2', 'VSS', 'power_in', 'GND'],
      ['3', 'VDD', 'power_in', '3V3'],
      ['4', 'A0', 'input', 'GND'],
      ['5', 'SDA', 'bidirectional', 'SDA'],
      ['6', 'SCL', 'input', 'SCL'],
    ],
  },
  {
    ref: 'U3',
    value: 'TPS7A02',
    partNumber: 'TPS7A0233PDBVR',
    manufacturer: 'Texas Instruments',
    footprint: 'SOT-23-5',
    x: 60,
    y: 200,
    side: 'TOP',
    rawJson: { category: 'LDO 稳压器', vout: '3.3 V', iout: '200 mA', iq: '25 nA' },
    pins: [
      ['1', 'IN', 'power_in', '+5V'],
      ['2', 'GND', 'power_in', 'GND'],
      ['3', 'EN', 'input', '+5V'],
      ['5', 'OUT', 'power_out', '3V3'],
    ],
  },
  {
    ref: 'R1',
    value: '100k',
    partNumber: 'RC0603FR-07100KL',
    footprint: 'R_0603',
    x: 140,
    y: 60,
    side: 'TOP',
    rawJson: { category: '电阻', role: 'Rf 反馈电阻', tolerance: '1%' },
    pins: [
      ['1', '~', 'passive', 'U1_IN-'],
      ['2', '~', 'passive', 'VOUT_AMP'],
    ],
  },
  {
    ref: 'R2',
    value: '100k',
    partNumber: 'RC0603FR-07100KL',
    footprint: 'R_0603',
    x: 148,
    y: 60,
    side: 'TOP',
    rawJson: {
      category: '电阻',
      role: 'Rf 并联位',
      dnp: true,
      note: '设计为 DNP（不贴装）。若误贴或与 R1 焊锡桥接，Rf 等效 50k，闭环增益由 -10 变为 -5',
    },
    pins: [
      ['1', '~', 'passive', null],
      ['2', '~', 'passive', null],
    ],
  },
  {
    ref: 'R3',
    value: '10k',
    partNumber: 'RC0603FR-0710KL',
    footprint: 'R_0603',
    x: 100,
    y: 80,
    side: 'TOP',
    rawJson: { category: '电阻', role: 'Rin 输入电阻', tolerance: '1%' },
    pins: [
      ['1', '~', 'passive', 'VIN_SENS'],
      ['2', '~', 'passive', 'U1_IN-'],
    ],
  },
  {
    ref: 'R4',
    value: '4.7k',
    footprint: 'R_0603',
    x: 210,
    y: 130,
    side: 'TOP',
    rawJson: { category: '电阻', role: 'I2C 上拉 SDA' },
    pins: [
      ['1', '~', 'passive', '3V3'],
      ['2', '~', 'passive', 'SDA'],
    ],
  },
  {
    ref: 'R5',
    value: '4.7k',
    footprint: 'R_0603',
    x: 218,
    y: 130,
    side: 'TOP',
    rawJson: { category: '电阻', role: 'I2C 上拉 SCL' },
    pins: [
      ['1', '~', 'passive', '3V3'],
      ['2', '~', 'passive', 'SCL'],
    ],
  },
  {
    ref: 'R6',
    value: '100R',
    footprint: 'R_0603',
    x: 170,
    y: 80,
    side: 'TOP',
    rawJson: { category: '电阻', role: '输出串阻' },
    pins: [
      ['1', '~', 'passive', 'VOUT_AMP'],
      ['2', '~', 'passive', null],
    ],
  },
  {
    ref: 'C1',
    value: '10uF',
    footprint: 'C_0805',
    x: 50,
    y: 210,
    side: 'TOP',
    rawJson: { category: '电容', role: 'LDO 输入电容' },
    pins: [
      ['1', '~', 'passive', '+5V'],
      ['2', '~', 'passive', 'GND'],
    ],
  },
  {
    ref: 'C2',
    value: '22pF',
    footprint: 'C_0603',
    x: 144,
    y: 68,
    side: 'TOP',
    rawJson: { category: '电容', role: 'Cf 反馈补偿电容' },
    pins: [
      ['1', '~', 'passive', 'U1_IN-'],
      ['2', '~', 'passive', 'VOUT_AMP'],
    ],
  },
  {
    ref: 'C3',
    value: '1uF',
    footprint: 'C_0603',
    x: 70,
    y: 210,
    side: 'TOP',
    rawJson: { category: '电容', role: 'LDO 输出电容' },
    pins: [
      ['1', '~', 'passive', '3V3'],
      ['2', '~', 'passive', 'GND'],
    ],
  },
  {
    ref: 'C4',
    value: '100nF',
    footprint: 'C_0603',
    x: 80,
    y: 210,
    side: 'TOP',
    rawJson: { category: '电容', role: 'LDO 输出高频旁路' },
    pins: [
      ['1', '~', 'passive', '3V3'],
      ['2', '~', 'passive', 'GND'],
    ],
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    ref: `Cdec${i + 1}`,
    value: '100nF',
    footprint: 'C_0603',
    x: 90 + i * 12,
    y: 240,
    side: 'TOP',
    rawJson: {
      category: '电容',
      role: '去耦电容',
      note: i < 2 ? '距 U1 电源引脚约 8 mm，偏远' : undefined,
    },
    pins: [
      ['1', '~', 'passive', i < 3 ? '+5V' : '3V3'],
      ['2', '~', 'passive', 'GND'],
    ] as [string, string, string, string | null][],
  })),
  {
    ref: 'J1',
    value: 'VIN',
    footprint: 'SMA_Edge',
    x: 20,
    y: 80,
    side: 'TOP',
    rawJson: { category: '连接器', role: '信号输入' },
    pins: [
      ['1', 'SIG', 'passive', 'VIN_SENS'],
      ['2', 'GND', 'passive', 'GND'],
    ],
  },
  {
    ref: 'J2',
    value: 'VOUT',
    footprint: 'SMA_Edge',
    x: 250,
    y: 80,
    side: 'TOP',
    rawJson: { category: '连接器', role: '信号输出' },
    pins: [
      ['1', 'SIG', 'passive', 'VOUT_AMP'],
      ['2', 'GND', 'passive', 'GND'],
    ],
  },
] as const

export const TEST_POINTS = [
  { label: 'TP1', net: 'VIN_SENS', description: '输入信号测试点', x: 90, y: 70, source: 'KICAD' },
  { label: 'TP2', net: 'VOUT_AMP', description: '输出信号测试点', x: 190, y: 70, source: 'KICAD' },
  { label: 'TP3', net: 'VREF', description: '偏置参考测试点（当前网表未接 Vref）', x: 130, y: 110, source: 'KICAD' },
  { label: 'TP4', net: '3V3', description: '数字电源测试点', x: 60, y: 230, source: 'KICAD' },
] as const

type V = {
  code: string
  origin: string
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  title: string
  description: string
  evidence: string[]
  risk: string
  suggestion: string
  recommendedTest?: string
  componentRef?: string
  netName?: string
}

/** 18 条，对齐总览页统计：高风险 3 / 中风险 6 / 低风险 9 */
export const VIOLATIONS: V[] = [
  {
    code: 'SUPPLY_HEADROOM_INSUFFICIENT',
    origin: 'AI',
    severity: 'CRITICAL',
    title: '单电源缺 Vref 偏置',
    description:
      'U1 工作在单电源 5V 下的反相放大结构，同相端 U1.3 直接接 GND。反相放大输出只能相对同相端电位摆动，同相端为 0V 时输出无法向下摆，被钳在轨底约 0V。',
    evidence: [
      'U1.3 (IN+) 网络为 GND，非预期的 VREF',
      'U1.4 (V-) = GND，U1.8 (V+) = +5V，确为单电源供电',
      'TP3 (VREF) 在网表中无驱动源',
      '实测 scenario=no_response：CH2 直流 15mV，无 1kHz 交流分量',
    ],
    risk: '输出恒为 0V，放大器完全不工作。这是当前项目 currentIssue 的直接成因。',
    suggestion:
      '在 U1.3 与 GND/+5V 之间加 100k/100k 分压产生 2.5V 偏置，并用 1uF 电容旁路；或改用 ±2.5V 双电源。',
    recommendedTest: '用 DMM 测 TP3 对地直流电压，预期 2.5V',
    componentRef: 'U1',
    netName: 'VREF',
  },
  {
    code: 'OUTPUT_SWING_CLIPPING_RISK',
    origin: 'AI',
    severity: 'CRITICAL',
    title: '输出摆幅削顶风险',
    description:
      '单电源 5V 下 AD8605 最大输出摆幅约 4.96 Vpp。设计增益 -10 时，输入超过约 0.49 Vpp 输出即削顶，可用输入范围过窄。',
    evidence: [
      'AD8605 轨到轨输出，余量 ±20mV，5V 轨下摆幅上限 4.96 Vpp',
      '设计增益 |Av| = Rf/Rin = 100k/10k = 10',
      '不削顶的输入上限 = 4.96/10 = 0.496 Vpp',
      '实测 scenario=clipping：输入 1.000Vpp 时 THD+N 升至 28.2%，Vmax 4.98V 贴轨',
    ],
    risk: '输入稍大即产生严重谐波失真，传感器动态范围被压缩。',
    suggestion: '降低增益到 -5 以内，或提高供电至 ±5V 双电源以增加输出余量。',
    recommendedTest: '扫输入幅度 0.1~1.0 Vpp，观察 THD+N 拐点',
    componentRef: 'U1',
    netName: 'VOUT_AMP',
  },
  {
    code: 'I2C_PULLUP_MISSING',
    origin: 'RULE_ENGINE',
    severity: 'CRITICAL',
    title: 'I2C 上拉阻值偏大',
    description:
      'SDA/SCL 上拉电阻为 4.7kΩ。若总线速率提高到 400kHz 或总线电容超过 200pF，上升沿会过慢导致采样失败。',
    evidence: [
      'R4 = 4.7k 上拉 SDA 到 3V3',
      'R5 = 4.7k 上拉 SCL 到 3V3',
      'MCP4725 支持 400kHz 快速模式',
    ],
    risk: '通信可靠性下降，可能出现 ACK 失败或数据错位。',
    suggestion: '评估总线电容，400kHz 下建议减小到 2.2kΩ。',
    recommendedTest: '示波器看 SCL 上升沿时间，应 < 300ns',
    componentRef: 'U2',
    netName: 'SCL',
  },

  {
    code: 'DECOUPLING_PLACEMENT_POOR',
    origin: 'RULE_ENGINE',
    severity: 'WARNING',
    title: '去耦电容位置不佳',
    description: 'Cdec1/Cdec2 距离 U1 电源引脚约 8mm，回路电感偏大，高频去耦效果打折。',
    evidence: ['Cdec1 距 U1.8 约 8.2 mm', 'Cdec2 距 U1.8 约 7.6 mm', '建议值 < 2 mm'],
    risk: '电源噪声可能耦合进放大链路，抬高噪底。',
    suggestion: '把至少一颗 100nF 移到紧邻 U1.8 的位置，过孔直接下地平面。',
    recommendedTest: '测 +5V 在 U1.8 处的纹波，应 < 20 mVpp',
    componentRef: 'U1',
    netName: '+5V',
  },
  {
    code: 'INPUT_BIAS_CURRENT_ERROR',
    origin: 'AI',
    severity: 'WARNING',
    title: '输入偏置电流影响',
    description:
      '传感器源阻抗较高时，输入偏置电流在源阻抗上产生失调电压。AD8605 的 Ib 仅 1pA，影响很小，但同相端未做阻抗匹配。',
    evidence: ['AD8605 Ib = 1 pA (typ)', 'R3 = 10k，Rf = 100k，等效源阻抗约 9.1k', 'U1.3 直接接地，无匹配电阻'],
    risk: '直流失调略有增加，对高精度测量有影响。',
    suggestion: '同相端串 9.1k 匹配电阻，或在低精度场景忽略。',
    componentRef: 'U1',
    netName: 'U1_IN-',
  },
  {
    code: 'GND_REFERENCE_DISCONTINUITY',
    origin: 'AI',
    severity: 'WARNING',
    title: '地参考不连续',
    description: '模拟地与数字地汇流路径过长，回流被迫绕行，形成较大环路面积。',
    evidence: ['模拟区到数字区最短回流路径约 24 mm', 'U2 下方地平面被 I2C 走线割裂'],
    risk: '数字开关噪声耦合进模拟链路。',
    suggestion: '在 U2 与 U1 之间增加地平面缝合过孔，或改单点接地。',
    componentRef: 'U2',
    netName: 'GND',
  },
  {
    code: 'OPAMP_FEEDBACK_SUSPECT',
    origin: 'RULE_ENGINE',
    severity: 'WARNING',
    title: '反馈补偿电容偏小',
    description: 'C2 = 22pF 与 Rf = 100k 构成的极点在 72kHz，对 10MHz GBW 的 AD8605 而言补偿偏弱。',
    evidence: ['C2 = 22 pF', 'Rf = 100 k', 'f_p = 1/(2π·100k·22p) ≈ 72 kHz', 'AD8605 GBW = 10 MHz'],
    risk: '高频增益过大，可能出现振铃或相位裕度不足。',
    suggestion: '按带宽需求重算补偿，或做闭环频响验证。',
    recommendedTest: '方波响应看过冲，或扫频测相位裕度',
    componentRef: 'U1',
    netName: 'VOUT_AMP',
  },
  {
    code: 'LDO_CAP_MISSING',
    origin: 'RULE_ENGINE',
    severity: 'WARNING',
    title: 'LDO 输出电容余量不足',
    description: 'TPS7A02 输出侧仅 C3 1uF + C4 100nF，负载瞬态较大时压降偏多。',
    evidence: ['C3 = 1 uF', 'C4 = 100 nF', 'TPS7A02 Iout = 200 mA'],
    risk: '负载跳变时 3V3 出现瞬态跌落，可能影响 U2 通信。',
    suggestion: '输出侧补一颗 10uF。',
    componentRef: 'U3',
    netName: '3V3',
  },
  {
    code: 'CONNECTOR_UNPROTECTED',
    origin: 'RULE_ENGINE',
    severity: 'WARNING',
    title: '连接器缺少保护',
    description: 'J1/J2 为板外接口，未见 TVS 或反接保护。',
    evidence: ['J1 (VIN_SENS) 直连 R3', 'J2 (VOUT_AMP) 直连 R6', '两者均无 TVS'],
    risk: '外部异常电压可能击穿 U1 输入级。',
    suggestion: '输入端加 TVS 或反并联二极管做二级钳位。',
    componentRef: 'J1',
    netName: 'VIN_SENS',
  },

  // origin=ERC 的三条对应 KiCad ERC 警告，使设计审查页的「ERC 警告 3 / DRC 违规 0」来自数据本身
  ...([
    ['SINGLE_PIN_NET', 'ERC', 'U1 空引脚未标 NC', 'U1.5~U1.7 为 NC 引脚，原理图未加 no-connect 标记', 'U1'],
    ['FLOATING_INPUT', 'ERC', 'R6 输出端悬空', 'R6.2 未连接到 J2 或负载，网表中为单点网络', 'R6'],
    ['SINGLE_PIN_NET', 'ERC', 'U2 VOUT 未使用', 'MCP4725 的 VOUT 引脚未连接到任何网络', 'U2'],
    ['SINGLE_PIN_NET', 'RULE_ENGINE', 'R2 两端均未连接', 'R2 设计为 DNP，网表中两个引脚均无连接（预期行为）', 'R2'],
    ['DECOUPLING_INSUFFICIENT', 'RULE_ENGINE', 'U2 去耦偏少', 'U2 VDD 仅共用 3V3 平面上的 Cdec，未就近单独去耦', 'U2'],
    ['CONNECTOR_UNPROTECTED', 'RULE_ENGINE', 'J2 输出未串保护', 'J2 输出仅经 R6 100Ω 限流，无过压保护', 'J2'],
    ['OPEN_DRAIN_NO_PULLUP', 'RULE_ENGINE', 'A0 地址脚固定接地', 'U2.A0 接 GND 固定地址 0x60，无法多器件扩展', 'U2'],
    ['LDO_CAP_MISSING', 'RULE_ENGINE', 'U3 EN 无上电延时', 'U3.EN 直接接 +5V，无 RC 延时，上电顺序不可控', 'U3'],
    ['DECOUPLING_INSUFFICIENT', 'RULE_ENGINE', 'Cdec 分布不均', '6 颗去耦电容 3 颗在 +5V、3 颗在 3V3，模拟侧偏少', undefined],
  ] as const).map(([code, origin, title, ev, ref], i) => ({
    code,
    origin,
    severity: 'INFO' as const,
    title,
    description: ev,
    evidence: [ev],
    risk: '影响较小，可在下一版优化。',
    suggestion: '记录到改进清单，不阻塞本次调试。',
    componentRef: ref,
    // 6 条 RULE_ENGINE 低风险标记为已处理，3 条 ERC 保持未解决。
    // 于是：未解决 = 高3 + 中6 + 低3 = 12（docs/03 总览页统计卡），
    //       总数 = 18（docs/02 Seed），ERC 警告 = 3（docs/03 设计审查页）——三个数字同时成立。
    resolved: i >= 3,
  })),
]

/**
 * 五个 scenario，数值严格对齐 docs/05 §11.1。
 * 统一激励：W2 → J1 正弦 1kHz offset 0；W1 → TP3(VREF) 直流 2.5V。
 * 供电 5V 单电源，AD8605 RRIO 输出摆幅 0.02~4.98V（约 4.96Vpp）。
 */
export const CAPTURES = [
  {
    scenario: 'normal',
    no: 5,
    minutesAgo: 21,
    label: '正常：已补 Vref、R2 未贴',
    driveVpp: 0.4,
    ch1: { vpp: 0.4, vrms: 0.1414, freqHz: 1000.2, offsetV: 0.0021, vmax: 2.7, vmin: 2.3, thdnPct: 0.28 },
    ch2: { vpp: 3.992, vrms: 1.4114, freqHz: 1000.2, offsetV: -0.0062, vmax: 4.5, vmin: 0.51, thdnPct: 0.32 },
    gain: 9.98,
    gainDb: 19.98,
    phaseDeg: 176.8,
    phaseDeviationDeg: -3.2,
  },
  {
    scenario: 'gain_error',
    no: 8,
    minutesAgo: 0,
    label: 'R2 桥接，增益减半',
    driveVpp: 0.4,
    ch1: { vpp: 0.4, vrms: 0.1414, freqHz: 1000.2, offsetV: 0.0062, vmax: 2.7, vmin: 2.3, thdnPct: 0.32 },
    ch2: { vpp: 2.002, vrms: 0.7078, freqHz: 1000.2, offsetV: -0.0021, vmax: 3.5, vmin: 1.5, thdnPct: 0.35 },
    gain: 5.0,
    gainDb: 13.98,
    phaseDeg: 176.8,
    phaseDeviationDeg: -3.2,
  },
  {
    scenario: 'clipping',
    no: 6,
    minutesAgo: 14,
    label: '削顶：输入 1.000Vpp 超出摆幅',
    driveVpp: 1.0,
    ch1: { vpp: 1.0, vrms: 0.3536, freqHz: 1000.2, offsetV: 0.0035, vmax: 3.0, vmin: 2.0, thdnPct: 0.31 },
    ch2: { vpp: 4.96, vrms: 1.8103, freqHz: 1000.2, offsetV: -0.0048, vmax: 4.98, vmin: 0.02, thdnPct: 28.2 },
    gain: 4.95,
    gainDb: 13.89,
    phaseDeg: 176.8,
    phaseDeviationDeg: -3.2,
  },
  {
    scenario: 'noisy',
    no: 7,
    minutesAgo: 7,
    label: '噪声：去耦与地回路劣化',
    driveVpp: 0.4,
    ch1: { vpp: 0.4, vrms: 0.1418, freqHz: 1000.2, offsetV: 0.0029, vmax: 2.71, vmin: 2.29, thdnPct: 0.42 },
    ch2: { vpp: 4.068, vrms: 1.4142, freqHz: 1000.2, offsetV: -0.0071, vmax: 4.55, vmin: 0.48, thdnPct: 1.9 },
    gain: 9.98,
    gainDb: 19.98,
    phaseDeg: 176.8,
    phaseDeviationDeg: -3.2,
  },
  {
    scenario: 'no_response',
    no: 4,
    minutesAgo: 28,
    label: '无响应：U1.3 接 GND，缺 Vref 偏置',
    driveVpp: 0.4,
    ch1: { vpp: 0.4, vrms: 0.1414, freqHz: 1000.2, offsetV: 0.0018, vmax: 0.2, vmin: -0.2, thdnPct: 0.3 },
    ch2: { vpp: 0.0, vrms: 0.0002, freqHz: 0, offsetV: 0.015, vmax: 0.02, vmin: 0.01, thdnPct: 0 },
    gain: 0,
    gainDb: -80,
    phaseDeg: 0,
    phaseDeviationDeg: 0,
  },
] as const

export const DEFAULT_SCENARIO = 'gain_error'

/**
 * 三条早期捕获，让测量总数达到文档里的 8（docs/03 统计卡「最近测量 8」、
 * docs/02 报告统计「8 测量」），且默认展示的 gain_error 正好是最新的 #8。
 * 它们不属于任何 scenario，切换场景时不参与。
 */
export const EARLY_CAPTURES = [
  {
    no: 1,
    minutesAgo: 63,
    kind: 'DMM' as const,
    label: '上电检查：+5V 与 3V3 直流电平',
    net: '+5V',
    measurements: { dc: { '+5V': 5.02, '3V3': 3.29 }, note: '对应调试计划步骤 1.1 与 1.2' },
  },
  {
    no: 2,
    minutesAgo: 51,
    kind: 'POWER' as const,
    label: '电源纹波：U1.8 处 +5V',
    net: '+5V',
    measurements: { ripplemVpp: 12.4, bandwidthHz: 20_000_000, note: '对应调试计划步骤 1.5' },
  },
  {
    no: 3,
    minutesAgo: 38,
    kind: 'LOGIC' as const,
    label: 'I2C 总线活动：SDA/SCL',
    net: 'SCL',
    measurements: { sclKHz: 100, ackAddress: '0x60', riseTimeNs: 260, note: '对应调试计划第 5 组' },
  },
]

/** 5 组 22 步。第 1 组按单电源改写（docs/05 §16.2）。 */
export const PLAN_GROUPS = [
  {
    title: '电源检查',
    steps: [
      {
        title: '检查 +5V 输入电源',
        tool: '万用表',
        min: 1,
        objective: '确认 J1 供电侧 +5V 电压在容差内',
        targetNet: '+5V',
        expected: '4.75 ~ 5.25 V',
        expectedValue: { value: '5.02', unit: 'V', label: '直流电压' },
        abnormal: ['低于 4.75V：检查供电源与线缆压降', '无电压：检查连接器与保险丝'],
        status: 'COMPLETED',
        result: { measured: '5.02 V', verdict: '正常' },
      },
      {
        title: '检查 +3V3 数字电源',
        tool: '万用表',
        min: 1,
        objective: '确认 TPS7A02 输出正常',
        targetNet: '3V3',
        targetComponent: 'U3',
        expected: '3.234 ~ 3.366 V',
        expectedValue: { value: '3.29', unit: 'V', label: '直流电压' },
        abnormal: ['无输出：检查 U3.EN 是否使能', '电压偏低：检查负载电流是否超 200mA'],
        status: 'COMPLETED',
        result: { measured: '3.29 V', verdict: '正常' },
      },
      {
        title: '检查 Vref 偏置电压（TP3）',
        tool: '万用表',
        min: 2,
        objective: '确认运放同相端偏置是否建立在 2.5V',
        targetNet: 'VREF',
        targetComponent: 'U1',
        expected: '2.40 ~ 2.60 V',
        expectedValue: { value: '2.50', unit: 'V', label: '直流电压' },
        abnormal: [
          '读数接近 0V：同相端被直接接地，缺 Vref 偏置电路，即本项目根因',
          '读数接近 5V：分压比例错误或上分压电阻开路',
        ],
        status: 'COMPLETED',
        result: { measured: '0.001 V', verdict: '异常', note: 'U1.3 直接接 GND，Vref 未建立' },
      },
      {
        title: '检查模拟地与数字地连接',
        tool: '万用表',
        min: 2,
        objective: '确认两地在单点可靠连接，阻抗足够低',
        targetNet: 'GND',
        expected: '< 100 mΩ',
        expectedValue: { value: '28', unit: 'mΩ', label: '地阻抗' },
        abnormal: ['阻抗过大：检查缝合过孔与地平面割裂'],
        status: 'COMPLETED',
        result: { measured: '28 mΩ', verdict: '正常' },
      },
      {
        title: '检查电源纹波',
        tool: '示波器',
        min: 3,
        objective: '在 U1.8 处测 +5V 纹波峰峰值',
        targetNet: '+5V',
        expected: '< 20 mVpp',
        expectedValue: { value: '12.4', unit: 'mVpp', label: '电源纹波' },
        abnormal: ['纹波偏大：检查去耦电容位置，见高风险项去耦电容位置不佳'],
        status: 'COMPLETED',
        result: { measured: '12.4 mVpp', verdict: '正常' },
      },
    ],
  },
  {
    title: '输入激励检查',
    steps: [
      {
        title: '检查输入 Vin 是否存在',
        tool: '示波器',
        min: 2,
        objective: '确认 TP1 上有 1kHz 正弦激励',
        targetNet: 'VIN_SENS',
        expected: '1 kHz 正弦，幅度符合信号源设置',
        expectedValue: { value: '0.400', unit: 'Vpp', label: '输入幅度' },
        abnormal: ['无信号：检查 W2 输出是否使能与接线', '频率不符：检查信号源设置'],
        status: 'COMPLETED',
        result: { measured: '0.400 Vpp @ 1.0002 kHz', verdict: '正常' },
      },
      {
        title: '检查输入幅度与偏置',
        tool: '示波器',
        min: 2,
        objective: '确认输入幅度未超过不削顶上限 0.49Vpp',
        targetNet: 'VIN_SENS',
        expected: '幅度 ≤ 0.49 Vpp，直流偏置接近 Vref',
        abnormal: ['幅度过大：输出必然削顶，先降幅再继续'],
        status: 'PENDING',
      },
      {
        title: '检查输入源阻抗',
        tool: '万用表',
        min: 1,
        objective: '确认源阻抗与 R3 匹配，排除分压效应',
        targetComponent: 'R3',
        expected: 'R3 = 9.9 ~ 10.1 kΩ',
        abnormal: ['阻值偏差大：检查贴装料号'],
        status: 'PENDING',
      },
    ],
  },
  {
    title: '运放工作点检查',
    steps: [
      {
        title: '检查反相端电压（V−）',
        tool: 'ADALM2000',
        min: 2,
        objective: '确认运放反相输入端的直流电压是否在合理范围内',
        targetNet: 'U1_IN-',
        targetComponent: 'U1',
        expected: '虚地应等于同相端电位，正常设计下为 2.5 V（Vref）',
        expectedValue: { value: '2.50', unit: 'V', label: '直流电压（预期）' },
        abnormal: [
          '读数接近 0V：同相端接地，Vref 缺失，输出被钳在轨底 → 转步骤 1.3',
          '电压大幅偏离预期：检查输入偏置、反馈电阻、相关元件是否开路或短路',
        ],
        setup: {
          mode: 'DMM',
          wiring: [
            { from: 'CH1 正极', to: 'U1.2 (U1_IN−)' },
            { from: 'CH1 负极', to: 'GND（模拟地）' },
          ],
          range: 'Auto',
          trigger: 'N/A（直流测量）',
          requiresConfirm: false,
          safetyNotes: ['直流测量，无需信号源输出'],
        },
        status: 'COMPLETED',
        result: { measured: '0.0008 V', verdict: '异常', note: '虚地落在 0V 而非 2.5V，根因确认' },
      },
      {
        title: '检查同相端电压（V+）',
        tool: 'ADALM2000',
        min: 2,
        objective: '确认同相端是否接到 Vref 而非 GND',
        targetComponent: 'U1',
        expected: '2.5 V',
        abnormal: ['读数 0V：网表将 U1.3 接到 GND，需改设计'],
        status: 'PENDING',
      },
      {
        title: '检查输出静态电压',
        tool: 'ADALM2000',
        min: 2,
        objective: '无激励时测输出直流电平',
        targetNet: 'VOUT_AMP',
        expected: '2.5 V（正常）或贴轨（异常）',
        expectedValue: { value: '0.0', unit: 'V', label: '输出静态' },
        abnormal: ['贴 0V 或贴 5V：运放饱和，检查偏置与反馈'],
        status: 'COMPLETED',
        result: { measured: '0.0 V', verdict: '异常', note: '输出贴轨底' },
      },
      {
        title: '检查反馈网络连通性',
        tool: '万用表',
        min: 1,
        objective: '断电测 R1 阻值，确认 Rf 未被并联',
        targetComponent: 'R1',
        expected: 'R1 = 99 ~ 101 kΩ',
        abnormal: ['读数约 50k：R2 被误贴或与 R1 桥接，Rf 等效减半 → 增益由 10 变 5'],
        status: 'PENDING',
      },
    ],
  },
  {
    title: '焊接与装配检查',
    steps: [
      {
        title: '检查可疑焊点（R1、R2、U1）',
        tool: '目视',
        min: 2,
        objective: '重点看 R1/R2 之间是否存在焊锡桥接',
        targetComponent: 'R2',
        expected: 'R1 与 R2 焊盘之间无连锡',
        abnormal: ['发现桥接：清除后复测增益，应恢复到 10.0 ±2%'],
        status: 'PENDING',
      },
      {
        title: '检查元件方向与型号',
        tool: '目视',
        min: 2,
        objective: '核对 U1/U2/U3 丝印方向与 BOM 一致',
        expected: '与 KiCad 设计视图一致',
        abnormal: ['方向错误：重新返修'],
        status: 'PENDING',
      },
      {
        title: '检查焊盘虚焊与冷焊',
        tool: '目视',
        min: 2,
        objective: '重点看 R6 与连接器焊点',
        targetComponent: 'R6',
        expected: '焊点饱满有光泽',
        abnormal: ['焊点发暗或球状：补焊'],
        status: 'PENDING',
      },
    ],
  },
  {
    title: '协议与数字信号',
    steps: [
      {
        title: 'I2C 总线是否有活动',
        tool: '逻辑分析仪',
        min: 3,
        objective: '确认 SDA/SCL 有正常时钟与数据',
        targetNet: 'SCL',
        expected: '可见起始位与时钟',
        abnormal: ['总线静默：检查主机是否发起传输'],
        status: 'PENDING',
      },
      {
        title: 'I2C 地址扫描',
        tool: '逻辑分析仪',
        min: 3,
        objective: '确认 MCP4725 在 0x60 应答',
        targetComponent: 'U2',
        expected: '0x60 返回 ACK',
        abnormal: ['无 ACK：检查 A0 接法与上拉电阻'],
        status: 'PENDING',
      },
      {
        title: '检查 I2C 上拉电阻',
        tool: '逻辑分析仪',
        min: 2,
        objective: '测 SCL 上升沿时间',
        targetComponent: 'R5',
        expected: '上升沿 < 300 ns',
        abnormal: ['上升沿过慢：把 4.7k 减小到 2.2k'],
        status: 'PENDING',
      },
      {
        title: '寄存器读写验证',
        tool: 'ADALM2000',
        min: 3,
        objective: '写入 DAC 码值并回读确认',
        targetComponent: 'U2',
        expected: '回读值与写入一致',
        abnormal: ['回读不符：检查总线时序与电源'],
        status: 'PENDING',
      },
    ],
  },
  {
    title: '自定义步骤',
    steps: [
      {
        title: '复测闭环增益并留档',
        tool: 'ADALM2000',
        min: 3,
        objective: '桥接清除后复测 1kHz 增益，确认恢复到 10.0 ±2%',
        targetNet: 'VOUT_AMP',
        expected: 'Gain = 9.8 ~ 10.2 V/V',
        abnormal: ['仍为 5：检查 R1 实际阻值与贴装料号'],
        status: 'PENDING',
      },
      {
        title: '扫频验证带宽与相位裕度',
        tool: 'ADALM2000',
        min: 5,
        objective: '100Hz~1MHz 扫频，看 -3dB 点与相位',
        targetNet: 'VOUT_AMP',
        expected: '-3dB 带宽 ≥ 100 kHz',
        abnormal: ['带宽不足：检查 C2 补偿取值'],
        status: 'PENDING',
      },
      {
        title: '整机复测并生成报告',
        tool: 'ADALM2000',
        min: 4,
        objective: '五个场景逐一复测，汇总生成调试报告',
        expected: '全部指标满足设计要求',
        abnormal: ['仍有异常项：回到对应分组重新排查'],
        status: 'PENDING',
      },
    ],
  },
] as const

/** 视觉检测结果，对齐 docs/02 Seed 与 docs/03 页面 4 */
export const VISUAL_FINDINGS = [
  {
    code: 'SOLDER_BRIDGE',
    title: '疑似焊锡桥接',
    detail: 'R1 与 R2 之间焊盘间隙可见连锡。R2 设计为 DNP，若被桥接则 Rf 等效 50k，闭环增益由 10 降为 5，与实测 Gain 5.00 一致。',
    confidence: 0.92,
    severity: '高风险',
    componentRef: 'R2',
    region: { x: 0.46, y: 0.34, w: 0.09, h: 0.07 },
    certainty: 'SUSPECTED',
  },
  {
    code: 'MISSING_PART',
    title: '可能缺少电容',
    detail: 'C4 位置未检测到元件，疑似缺件。需确认 BOM 与贴装要求。',
    confidence: 0.88,
    severity: '中风险',
    componentRef: 'C4',
    region: { x: 0.72, y: 0.61, w: 0.06, h: 0.06 },
    certainty: 'SUSPECTED',
  },
  {
    code: 'POLARITY',
    title: '连接器极性检查',
    detail: 'J2 (VOUT) 极性方向正确，与设计一致。',
    confidence: 0.99,
    severity: '正常',
    componentRef: 'J2',
    region: { x: 0.88, y: 0.42, w: 0.08, h: 0.12 },
    certainty: 'CONFIRMED',
  },
  {
    code: 'ORIENTATION',
    title: '芯片方向检查',
    detail: 'U1 (AD8605) 第一脚标记方向与设计一致。',
    confidence: 0.98,
    severity: '正常',
    componentRef: 'U1',
    region: { x: 0.41, y: 0.3, w: 0.14, h: 0.16 },
    certainty: 'CONFIRMED',
  },
  {
    code: 'JOINT_QUALITY',
    title: '焊点质量问题',
    detail: 'R6 焊点较大、外观不佳，建议优化。不影响电气连接。',
    confidence: 0.75,
    severity: '低风险',
    componentRef: 'R6',
    region: { x: 0.63, y: 0.45, w: 0.05, h: 0.05 },
    certainty: 'SUSPECTED',
  },
] as const

/** 对默认场景 gain_error 的诊断，输出结构对齐 docs/05 §7.3 与 §8.4 few-shot */
export const DIAGNOSIS = {
  severity: 'CRITICAL' as const,
  rootCause: 'R1(Rf) 被焊锡桥接并联 R2，等效反馈电阻约 50k，闭环增益由 -10 降为 -5',
  confidence: 0.86,
  evidence: [
    '期望 |Av| = Rf/Rin = 100k/10k = 10，实测 2.002Vpp/0.400Vpp = 5.00',
    '实测增益恰为期望的 1/2，等效 Rf ≈ 50k = 100k ∥ 100k',
    'R2 标称 100k 且设计为 DNP 的 Rf 并联位，视觉检测报告 R1/R2 间疑似桥接（置信度 0.92）',
    'THD+N=0.35% 且 Vmax=3.50V/Vmin=1.50V 均在 5V 轨内，波形无平顶，排除削顶导致的增益下降',
  ],
  alternativeCauses: [
    { cause: 'R1 实际贴装为 49.9k（贴错料）', likelihood: 0.1 },
    { cause: '输入端 R3 实际为 20k', likelihood: 0.04 },
  ],
  recommendations: [
    {
      order: 1,
      action: '断电后用万用表直接测 R1 两端阻值',
      detail: '预期 100k；若读数约 50k 则桥接/并联成立，可直接定位',
      targetComponent: 'R1',
      instrumentPreset: {
        mode: 'DMM',
        wiring: [
          { from: 'DMM+', to: 'R1.1' },
          { from: 'DMM-', to: 'R1.2' },
        ],
        requiresConfirm: false,
        safetyNotes: ['测阻值前必须断电'],
      },
    },
    {
      order: 2,
      action: '目视或显微镜检查 R1-R2 焊盘间隙并补测 R2 阻值',
      targetComponent: 'R2',
    },
    {
      order: 3,
      action: '清除桥接后复测 1kHz 增益，确认恢复到 10.0 ±2%',
      targetNet: 'VOUT_AMP',
    },
  ],
}
