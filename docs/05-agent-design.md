# 05 智能体设计（Board Debug Copilot Agent）

本文是 `packages/ai` 的权威实施规格。上游依赖：`docs/01`（架构与规则引擎）、`docs/02`（数据模型，关系不可改）、`docs/03`（UI 规格，决定输出字段）。
与 `docs/00` 冲突时，一律以 `docs/02` 为准（见 §12 差异表）。

---

## 1. 一句话定义

**一个智能体，六种技能，四类上下文。**

对用户只有一个「AI 调试参谋」（各页面右侧面板 + Ctrl+K 全局入口）；对内部是
`Router → ContextBuilder → Evidence → Tools → Skill → Guards → 落库/流式` 的确定性管线。

智能体的价值不是"会聊电路"，而是把四类上下文收敛成**唯一可验证的根因**：

```
Design Context      设计上下文   期望值从哪来（网表/拓扑/器件参数）
Part Knowledge      器件知识     参数边界从哪来（摆幅/偏置/负载能力）
Measurement Context 测量上下文   实际值从哪来（ADALM2000 摘要）
Visual Context      视觉上下文   物理现实从哪来（焊接/装配/缺件）
                          ↓
                 期望 vs 实际的差异 + 物理解释 + 下一步可执行测量
```

---

## 2. 分层架构

```
L0 Provider    chat / chatStream / vision / embed
               ClaudeProvider | DeepSeekProvider | MockProvider     ← 应用代码零直连 SDK
L1 Context     ContextBuilder：按技能装配 slice，压缩为 DesignDigest，做 token 预算
L2 Evidence    规则引擎 + ERC/DRC + 测量规则 + 视觉发现 + 器件库     ← 确定性，先于 LLM
L3 Tools       ToolRegistry：Zod in/out，按技能白名单，读写分离
L4 Skills      design_review / measure_guide / waveform_analyze /
               fault_diagnose / photo_analyze / report_generate / general_chat
L5 Orchestrate Router → 装配 → 工具循环(≤3轮) → 结构化输出 → 流式分发
L6 Guards      parse → schema → grounding → safety → dedupe → fallback
```

**硬约束**：L2 永远先于 L4 执行。LLM 的职责是**解释、排序、串联、生成可执行步骤**，
不是**发现问题**。凡是能用规则算出来的（削顶、增益不符、缺上拉），必须由 L2 给出，
LLM 只负责补充"为什么"和"接下来测什么"。这是 `docs/00 §2.2`「不允许 AI 只输出泛泛建议」的唯一可靠实现方式，
也是 `MOCK_MODE=true` 下仍能展示真实工程价值的原因。

---

## 3. 意图路由（Router）

```ts
export type AgentIntent =
  | 'design_review' | 'measure_guide' | 'waveform_analyze'
  | 'fault_diagnose' | 'photo_analyze' | 'report_generate' | 'general_chat'
```

三级路由，**优先级从高到低，命中即停**：

| 级别 | 来源 | 说明 |
|---|---|---|
| 1 | 显式 `mode` | 前端每个页面固定传 mode（设计审查页=`design_review`，工作台=`waveform_analyze`，照片页=`photo_analyze`，计划页=`fault_diagnose`，报告页=`report_generate`）。**覆盖 90% 请求，零额外 LLM 调用** |
| 2 | 关键词规则 | Ctrl+K 全局框：`接线|怎么测|设置` → measure_guide；`波形|削顶|增益|相位` → waveform_analyze；`焊|照片|贴片` → photo_analyze；`报告` → report_generate |
| 3 | LLM 分类 | 前两级都不命中时，用一次 ≤200 token 的分类调用（`temperature=0`，只输出 intent 枚举），失败降级 `general_chat` |

`AiThread.mode` 与 intent 同名，一个项目每种 mode 一个常驻 thread（`docs/02` 的 `messagesJson` 结构）。

---

## 4. 上下文层（ContextBuilder）

### 4.1 Slice 定义

```ts
export interface ProjectContext {
  project:      { id, name, currentIssue, status }
  designDigest?: string          // §4.2 压缩 DSL
  evidence?:     Finding[]       // L2 产出，已排序
  measurements?: CaptureBrief[]  // 最近 K 条 Capture 摘要（不含波形数组）
  visual?:       VisualBrief     // VisualFinding + PhotoAnnotation
  plan?:         PlanBrief       // DebugStep 树状态摘要（分组/完成数/当前步）
  history?:      ChatTurn[]      // AiThread 最近 M 轮，超限走摘要
}
```

### 4.2 DesignDigest：紧凑 DSL（**不要把 Prisma JSON 塞进 prompt**）

原始 JSON 一个项目轻松 30k token 且信噪比极低。统一压缩为：

```
[PROJECT] Sensor Board Debug Demo | issue: 输出无响应，Vout 一直为 0V
[SUPPLY] +5V (J1 输入, U1 模拟供电) | 3V3 (TPS7A02, Iout 200mA, 数字供电) | GND
[COMPONENTS] 22
  U1 AD8605 SOIC-8 opamp  RRIO Vs=2.7~5.5V(absmax 6V) Ib=1pA GBW=10MHz Vout=rail-to-rail(±20mV)
  U2 MCP4725 SOT-23-6 DAC-I2C addr=0x60
  U3 TPS7A02 LDO 3.3V
  R1 100k(Rf)  R2 100k(Rf 并联位, 设计为 DNP)  R3 10k(Rin)  R4/R5 4.7k(I2C-PU)  R6 100R(输出串阻)
  C1 10uF  C2 22pF(Cf)  C3 1uF  C4 100nF  Cdec 100nF x6
  J1 VIN  J2 VOUT  TP1..TP4
[NETS] 9
  VIN_SENS  role=SIGNAL exp=0.4Vpp@1kHz   pins=J1.1,R3.1,TP1
  U1_IN-    role=SIGNAL exp=Vref(virtual) pins=U1.2,R3.2,R1.1,C2.1  alias=N0012
  VOUT_AMP  role=SIGNAL exp=4.0Vpp@1kHz   pins=U1.1,R1.2,R6.1,TP2
  VREF      role=BIAS   exp=2.5V          pins=U1.3,TP3        ← 当前实际接 GND
  +5V       role=POWER  exp=5.0V          pins=U1.5,U3.1,C1.1
  3V3       role=POWER  exp=3.3V          pins=U2.3,R4.1,R5.1,U3.5
  SDA/SCL   role=I2C    exp=3.3V-OD       pins=U2.5/U2.6,R4.2/R5.2
  GND       role=GND
[TOPOLOGY]
  U1: inverting-amp  Rin=R3(10k) Rf=R1(100k) gain=-10  supply=single-5V  Vref=U1.3
      note1: 单电源下 U1.3 必须偏置到 ~2.5V；当前网表 U1.3 接 GND
             → 反相输出只能向下摆，被钳在轨底 ≈ 0V（与 currentIssue 一致）
      note2: 即使补上 Vref，5V 轨下最大摆幅 ≈ 4.96Vpp，增益 10 → 可用输入上限仅 0.49Vpp
             → OUTPUT_SWING_CLIPPING_RISK 成立
      note3: R2 与 R1 并联位相邻，若误贴/桥接则 Rf 等效 50k，增益降为 5
[TESTPOINTS] TP1=VIN_SENS TP2=VOUT_AMP TP3=VREF TP4=3V3
```

- `[TOPOLOGY]` 由 `packages/kicad/src/graph` 的模式识别产出（MVP 阶段读 seed，先 mock）。**这一段对输出质量的贡献大于其它所有段落之和**——没有它，LLM 只能从网表猜电路功能。
- 器件参数行来自 `PartsDatabaseAdapter`（mock 时给常识参数，禁止编造库存/价格）。
- 组件 >60 个时按类聚合（`R x24 (10k x8, 4.7k x4, ...)`），只展开被问及的和有 Finding 的。

### 4.3 预算表

| 技能 | 装配的 slice | 上下文预算 | 目标首字延迟 |
|---|---|---|---|
| design_review | designDigest + evidence | 6k | < 1.5s |
| measure_guide | designDigest + plan | 4k | < 1.5s |
| waveform_analyze | designDigest(裁剪到相关网络) + measurements + evidence | 5k | < 1.2s |
| fault_diagnose | 全部 | 12k | < 2.5s |
| photo_analyze | visual + designDigest(仅位号/位置) + 图像 | 4k + image | < 3s |
| report_generate | 全部（不流式，走 worker） | 20k | — |
| general_chat | project + history + designDigest 摘要 | 3k | < 1s |

超预算时的降级顺序：`history → 低危 Finding → 非相关网络 → 组件参数行`。

---

## 5. 证据层（L2，确定性）

### 5.1 归属

| 规则族 | 实现位置 | 依据 |
|---|---|---|
| 原理图规则（10 条） | `packages/kicad/src/rules/` | P3 已指定 |
| 测量规则（11 条） | `packages/ai/src/evidence/measurement-rules.ts` | P4 未指定，就近 AI 包 |
| 视觉规则（5 条） | `packages/ai/src/evidence/visual-rules.ts` | 阈值判定，AI 只填 detail |
| 合并/排序/去重 | `packages/ai/src/evidence/index.ts` | — |

**不新增 package**，目录结构按 `CLAUDE.md` 固定。

### 5.2 受控 code 词表

所有 Finding 的 `code` 必须来自下表。这是防"泛泛而谈"的第一道闸：
LLM 若给不出词表内的 code，就说明它没有具体证据，该条直接丢弃。

**原理图（RULE_ENGINE 可产出）**

```
POWER_NET_MISSING       GND_NET_MISSING        SINGLE_PIN_NET
FLOATING_INPUT          OPAMP_FEEDBACK_SUSPECT OPEN_DRAIN_NO_PULLUP
I2C_PULLUP_MISSING      DECOUPLING_INSUFFICIENT LDO_CAP_MISSING
RESET_PIN_FLOATING      CONNECTOR_UNPROTECTED
```

**设计推理（需器件参数+拓扑，`origin=AI`，但必须带 evidence）**

```
OUTPUT_SWING_CLIPPING_RISK   INPUT_BIAS_CURRENT_ERROR
GND_REFERENCE_DISCONTINUITY  DECOUPLING_PLACEMENT_POOR
SUPPLY_HEADROOM_INSUFFICIENT LOAD_DRIVE_INSUFFICIENT
```

**测量（MEASUREMENT）**

```
OUTPUT_CLIPPING   OFFSET_ABNORMAL   FREQ_MISMATCH    GAIN_MISMATCH
PHASE_MISMATCH    NOISE_EXCESSIVE   RINGING_OVERSHOOT INPUT_FLOATING
NO_RESPONSE       LOGIC_LEVEL_INVALID  THDN_HIGH
```

**视觉（VISION，对齐 `docs/02` VisualFinding.code）**

```
SOLDER_BRIDGE  MISSING_PART  POLARITY  ORIENTATION  JOINT_QUALITY
```

### 5.3 严重度映射（枚举 ↔ UI pill）

`docs/02` 里 `RuleViolation.severity` 是枚举、`VisualFinding.severity` 是中文字符串，必须有唯一映射：

```ts
const SEVERITY_UI = {
  CRITICAL: { label: '高风险', color: 'red' },
  WARNING:  { label: '中风险', color: 'orange' },
  INFO:     { label: '低风险', color: 'slate' },
} as const
// '正常'(green) 仅用于 VisualFinding，不对应任何 DiagnosisSeverity，落库时 severity 直接存 '正常'
```

---

## 6. 工具层（L3）

```ts
export interface AgentTool<I, O> {
  name: string
  description: string           // 直接进 LLM tool 描述，写清"什么时候用"
  input: z.ZodType<I>
  output: z.ZodType<O>
  kind: 'read' | 'write'
  needsConfirm?: boolean        // write 且影响硬件/数据时为 true
  run(input: I, ctx: AgentToolContext): Promise<O>
}
export interface AgentToolContext { projectId: string; userId?: string; scenario?: string }
```

| 工具 | kind | 说明 |
|---|---|---|
| `getProjectSummary` | read | 项目 + 状态 + 统计 |
| `getComponents` | read | 支持 `filter{category,ref,partNumber}` |
| `getComponentByRef` | read | 含 pins + 所在网络 + PartMatch 参数 |
| `getNets` / `getNetByName` | read | 含 pins 邻接、inferredRole、expected* |
| `getViolations` | read | RuleViolation，按 origin/severity 过滤 |
| `getTestPoints` | read | 用于 measure_guide 出接线方案 |
| `searchPartsDatabase` | read | 走 `PartsDatabaseAdapter`，mock 返回常识参数 |
| `getCaptureSummary` / `getRecentCaptures` | read | 只返回 `measurementsJson`，**永不返回波形数组** |
| `getPhotoFindings` | read | VisualFinding + PhotoAnnotation |
| `getDebugPlan` | read | DebugStep 树 + 状态 |
| `buildInstrumentPreset` | read | 纯计算：给定网络/期望值 → 量程/时基/触发（见 §8.3） |
| `createDebugSteps` | write | 落 DebugStep 树，`needsConfirm` |
| `saveDiagnosis` | write | 落 AiDiagnosis，`needsConfirm` |
| `createReportDraft` | write | 落 DebugReport，`needsConfirm` |

**每个技能只挂载白名单内的工具**（`docs/01` 已给出对应关系）。工具循环上限 **3 轮**，超限强制进入输出阶段；
工具报错返回 `{error}` 给模型而非抛出，让它在输出里降低 confidence。

---

## 7. 输出契约（`packages/contracts`）

所有字段**按 UI 需要**与**Prisma 列**双向对齐，不多不少。

### 7.1 Finding — 统一发现体（↔ `RuleViolation`）

```ts
export const OriginSchema = z.enum(['RULE_ENGINE','ERC','DRC','AI','MEASUREMENT','VISION'])
export const SeveritySchema = z.enum(['INFO','WARNING','CRITICAL'])

export const FindingSchema = z.object({
  code:            FindingCodeSchema,                 // §5.2 受控枚举
  origin:          OriginSchema,
  severity:        SeveritySchema,
  title:           z.string().min(4).max(30),         // UI 卡片标题，中文
  description:     z.string().min(20).max(400),
  evidence:        z.array(z.string()).min(1).max(6), // 落库 join('\n') → RuleViolation.evidence
  risk:            z.string().min(10).max(200),       // UI「影响：」行
  suggestion:      z.string().min(10).max(300),
  recommendedTest: z.string().max(200).optional(),
  componentRef:    z.string().max(16).optional(),     // 必须 ∈ 项目组件集（§9.3）
  netName:         z.string().max(32).optional(),     // 必须 ∈ 项目网络集
  confidence:      z.number().min(0).max(1),
})
```

> `evidence` 强制 ≥1 条，且 grounding 阶段要求至少一条包含具体数值或位号。空泛证据 = 丢弃该 Finding。

### 7.2 DesignReview（设计审查页）

```ts
export const DesignReviewSchema = z.object({
  summary:  z.string().max(300),
  findings: z.array(FindingSchema).min(1).max(12),
  bomRisk:  z.object({ high: z.number(), medium: z.number(), low: z.number(), total: z.number() }),
  ercDrc:   z.object({ errors: z.number(), warnings: z.number(), violations: z.number() }),
})
```

### 7.3 AiDiagnosis（工作台 / 计划页 ↔ `AiDiagnosis` 表）

```ts
export const RecommendationSchema = z.object({
  order:            z.number().int().min(1).max(5),
  action:           z.string().max(120),
  detail:           z.string().max(300).optional(),
  targetNet:        z.string().optional(),
  targetComponent:  z.string().optional(),
  instrumentPreset: InstrumentPresetSchema.optional(),   // 「一键应用仪器参数」
})

export const AiDiagnosisSchema = z.object({
  severity:          SeveritySchema,
  rootCause:         z.string().min(10).max(200),        // → rootCause
  confidence:        z.number().min(0).max(1),           // → confidence
  evidence:          z.array(z.string()).min(1).max(8),  // → evidenceJson
  alternativeCauses: z.array(z.object({                  // → rawJson.alternativeCauses（表无此列）
    cause: z.string().max(120), likelihood: z.number().min(0).max(1),
  })).max(3),
  recommendations:   z.array(RecommendationSchema).min(1).max(5), // → recommendationsJson
})
```

> ⚠️ `docs/02` 中 `AiDiagnosis.captureId` 是 `@unique`：**一个 Capture 只能有一条诊断**。
> 重新分析必须 `upsert` 覆盖，不能 `create`，否则唯一约束报错。

### 7.4 InstrumentPreset（↔ `DebugStep.setupJson` / `Capture.hardwareSetupJson`）

```ts
export const AwgConfigSchema = z.object({
  channel:      z.enum(['W1','W2']),
  wave:         z.enum(['sine','square','triangle','sawtooth','dc']),
  freqHz:       z.number().min(0).max(30_000_000),
  amplitudeVpp: z.number().min(0).max(10),      // ADALM2000 硬上限
  offsetV:      z.number().min(-5).max(5),
})
export const ScopeConfigSchema = z.object({
  timebaseSPerDiv: z.number().positive(),
  sampleRate:      z.number().positive().max(100_000_000),
  trigger: z.object({ source: z.enum(['CH1','CH2','EXT','NONE']), edge: z.enum(['rising','falling']), levelV: z.number() }),
  channels: z.record(z.enum(['CH1','CH2']), z.object({
    voltsPerDiv: z.number().positive(), coupling: z.enum(['DC','AC']), probe: z.enum(['1x','10x']).default('1x'),
  })),
})
export const InstrumentPresetSchema = z.object({
  mode:            z.enum(['SCOPE','DMM','AWG_SCOPE','FFT','LOGIC']),
  awg:             AwgConfigSchema.optional(),
  scope:           ScopeConfigSchema.optional(),
  wiring:          z.array(z.object({                 // UI 接线清单，逐条可勾选
    from: z.string(),                                  // 'CH1+'
    to:   z.string(),                                  // 'TP1 (VIN_SENS)'
    note: z.string().optional(),
  })).min(1),
  requiresConfirm: z.boolean(),                        // 由 §9.4 安全层写入，LLM 无权置 false
  safetyNotes:     z.array(z.string()),
})
```

### 7.5 DebugPlan（↔ `DebugStep` 树）

```ts
export const DebugStepSchema = z.object({
  order:          z.number().int(),
  title:          z.string().max(40),
  objective:      z.string().max(200),
  toolHint:       z.enum(['万用表','示波器','ADALM2000','逻辑分析仪','目视']),
  estimateMin:    z.number().int().min(1).max(60),
  setup:          InstrumentPresetSchema.optional(),
  targetNet:      z.string().optional(),
  targetComponent:z.string().optional(),
  expectedResult: z.string().max(200),
  expectedValue:  z.object({ value: z.string(), unit: z.string(), label: z.string() }).optional(), // 详情页大数字卡
  abnormalNext:   z.array(z.string()).min(1).max(3),  // 「异常情况与下一步」的 → 条目
})
export const DebugPlanSchema = z.object({
  issue:  z.string().max(200),
  goal:   z.string().max(200),
  groups: z.array(z.object({
    order: z.number().int(), title: z.string().max(20), steps: z.array(DebugStepSchema).min(1).max(10),
  })).min(1).max(8),
})
```

落库：group → `DebugStep{parentId:null}`，step → `DebugStep{parentId:group.id}`；
`abnormalNext` join `'\n'` 存字符串列。**「重新生成计划」只覆盖 `status=PENDING` 的步骤**（P6 已规定）。

### 7.6 VisualFindings / ReportDraft / CopilotAnswer

```ts
export const VisualFindingsSchema = z.object({
  findings: z.array(z.object({
    code: z.enum(['SOLDER_BRIDGE','MISSING_PART','POLARITY','ORIENTATION','JOINT_QUALITY']),
    title: z.string().max(30), detail: z.string().max(300),
    confidence: z.number().min(0).max(1),
    severity: z.enum(['高风险','中风险','低风险','正常']),
    componentRef: z.string().optional(),
    region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(), // 归一化
    certainty: z.enum(['CONFIRMED','SUSPECTED']),   // docs/00 §2.5 要求区分确定/疑似
  })).max(8),
})

export const ReportDraftSchema = z.object({
  title: z.string(), summaryMd: z.string(),
  toc: z.array(z.object({ id: z.string(), title: z.string(), level: z.number().int().min(1).max(2) })),
  sections: z.array(z.object({ id: z.string(), title: z.string(), markdown: z.string() })).min(7),
  stats: z.object({ issues: z.number(), resolved: z.number(), improvements: z.number(), measurements: z.number(), aiSuggestions: z.number() }),
})

// 总览页「AI 调试参谋」卡 + Ctrl+K 通用问答
export const CopilotAnswerSchema = z.object({
  possibleIssues: z.array(z.string().max(120)).max(3),
  keyEvidence: z.array(z.object({
    text: z.string().max(160),
    linkTo: z.object({ type: z.enum(['violation','capture','finding','step','photo']), id: z.string() }).optional(),
  })).max(5),                                        // UI「关键证据可链到高风险项 #3」
  nextSteps: z.array(z.object({ order: z.number().int(), text: z.string().max(160) })).min(1).max(5),
})
```

---

## 8. Prompt 规格

### 8.1 统一骨架

```
[SYSTEM]  角色 + 硬约束（§8.2）
[CONTEXT] <project> <design_digest> <evidence> <measurements> <visual> <plan>
[SCHEMA]  本技能的输出 JSON Schema（由 zod-to-json-schema 生成，不手写）
[FEWSHOT] 1 个来自 Demo 的正例（含一个"证据不足→低 confidence"的反例）
[USER]    用户问题 / 技能任务指令
```

### 8.2 全局硬约束（所有技能共用的 SYSTEM 片段）

```
你是板级硬件调试助手，服务对象是电子工程师。规则：
1. 只能使用 <context> 中出现的位号、网络名、数值。凡 <context> 未出现的一律不得提及。
2. 每条结论必须给出 evidence，evidence 必须包含具体数值或位号（如 "CH2 Vpp=2.002V"、"U1.3 接 GND"）。
   给不出具体证据时，删除该条，不要用"可能存在""建议检查一下"填充。
3. 当证据不足以支持结论时，输出 confidence < 0.5 并在 evidence 中写明缺什么测量。
4. 不要复述规则引擎已给出的 Finding，你的任务是解释成因、排序优先级、给出下一步可执行测量。
5. 仪器参数必须落在 ADALM2000 能力范围内：W1 输出 ±5V / ≤10Vpp，示波器输入 ±25V，采样率 ≤100MSPS。
6. 严格输出 <schema> 定义的 JSON，不要输出 JSON 以外的解释文字。
```

### 8.3 各技能差异

| 技能 | SYSTEM 追加 | 关键任务指令 |
|---|---|---|
| `design_review` | 按"电源→时钟/复位→接口→模拟→数字"顺序审查 | 输出 ≤12 条 Finding，高风险优先；每条须含 `recommendedTest` |
| `measure_guide` | 优先使用已有 TestPoint，无 TP 时指明可探测的引脚 | 输出 InstrumentPreset + 逐条接线；说明"为什么这么设时基/触发" |
| `waveform_analyze` | 先算期望值再比对实测，禁止只描述波形形状 | 输出 AiDiagnosis；必须写出「期望 X，实测 Y，差异 Z 倍/dB」 |
| `fault_diagnose` | 跨模态收敛：设计+测量+视觉必须至少两路互相印证 | 输出 AiDiagnosis + `alternativeCauses`；根因唯一 |
| `photo_analyze` | 区分 CONFIRMED / SUSPECTED；不确定就标 SUSPECTED | 输出 VisualFindings；置信度 <0.6 不得标 CONFIRMED |
| `report_generate` | 只汇总已落库事实，不得新增结论 | 输出 ReportDraft，7 章齐全（`docs/03` 页面 6） |

### 8.4 `waveform_analyze` 完整示例（其余技能照此扩写）

```
你是板级硬件调试助手……（§8.2 全部 6 条）

补充规则：
7. 分析前先从 [TOPOLOGY] 推导本次测量的期望值（增益/相位/摆幅/频率），写进 evidence。
8. 判定顺序固定：先看是否削顶 → 再看幅度/增益 → 再看频率 → 再看相位 → 最后看噪声与 THD。
9. 如果实测与期望的偏差可以由某个具体元件的错值/错装/桥接解释，必须点名该元件位号。
10. recommendations 的第一条必须是"能在 5 分钟内做完、且能证伪当前根因"的测量。

<context>
[TOPOLOGY] U1 inverting-amp Rin=R3(10k) Rf=R1(100k) gain=-10 supply=single-5V Vref=2.5V
           R2(100k) 为 Rf 并联位，设计为 DNP
[MEASUREMENT] capture#8 CH1(TP1/VIN_SENS) Vpp=0.400V f=1000.2Hz
              CH2(TP2/VOUT_AMP) Vpp=2.002V f=1000.2Hz phaseDev=-3.2° THD+N=0.35%
              derived: gain=5.00 V/V (13.98 dB), 波形无平顶, Vmax=3.50V Vmin=1.50V (轨内)
[EVIDENCE] GAIN_MISMATCH(MEASUREMENT,CRITICAL): 期望 |Av|=10，实测 5.00
           SOLDER_BRIDGE(VISION,0.92): R1/R2 之间疑似桥接
</context>
```

> `phaseDev` = 相对反相理想值 180° 的偏差（`docs/03` 显示为 `Phase -3.2°`）。
> 落库时 `measurementsJson.phaseDeg=176.8`、`phaseDeviationDeg=-3.2`，两者都存，避免 UI 与算法各解释一套。

期望输出（也用作 few-shot 正例）：

```json
{
  "severity": "CRITICAL",
  "rootCause": "R1(Rf) 被焊锡桥接并联 R2，等效反馈电阻约 50k，闭环增益由 -10 降为 -5",
  "confidence": 0.86,
  "evidence": [
    "期望 |Av| = Rf/Rin = 100k/10k = 10，实测 2.002Vpp/0.400Vpp = 5.00",
    "实测增益恰为期望的 1/2，等效 Rf ≈ 50k = 100k ∥ 100k",
    "R2 标称 100k 且设计为 DNP 的 Rf 并联位，视觉检测报告 R1/R2 间疑似桥接（置信度 0.92）",
    "THD+N=0.35% 且 Vmax=3.50V/Vmin=1.50V 均在 5V 轨内，波形无平顶，排除削顶导致的增益下降"
  ],
  "alternativeCauses": [
    { "cause": "R1 实际贴装为 49.9k（贴错料）", "likelihood": 0.10 },
    { "cause": "输入端 R3 实际为 20k", "likelihood": 0.04 }
  ],
  "recommendations": [
    { "order": 1, "action": "断电后用万用表直接测 R1 两端阻值",
      "detail": "预期 100k；若读数约 50k 则桥接/并联成立，可直接定位",
      "targetComponent": "R1",
      "instrumentPreset": { "mode": "DMM", "wiring": [{ "from": "DMM+", "to": "R1.1" }, { "from": "DMM-", "to": "R1.2" }],
                            "requiresConfirm": false, "safetyNotes": ["测阻值前必须断电"] } },
    { "order": 2, "action": "目视/显微镜检查 R1-R2 焊盘间隙并补测 R2 阻值", "targetComponent": "R2" },
    { "order": 3, "action": "清除桥接后复测 1kHz 增益，确认恢复到 10.0 ±2%", "targetNet": "VOUT_AMP" }
  ]
}
```

> 这条 few-shot 同时演示了三件事：**先算期望再比对**、**跨模态互证（测量×视觉）**、**第一条建议可在 5 分钟内证伪**。
> 这是整个智能体的能力样板，`MOCK_MODE` 下的预置输出也应以它为准。

---

## 9. 守卫管线（L6）

```
LLM raw
  ↓ ① parse      去 ```json 围栏 / 截断修复 / 提取首个平衡 JSON
  ↓ ② schema     zod.safeParse；失败 → 把 zod issues 回灌 LLM 修复一次（仅一次，docs/01 已定）
  ↓ ③ grounding  引用校验（§9.3）
  ↓ ④ safety     仪器参数校验与钳制（§9.4）
  ↓ ⑤ dedupe     与 L2 结果合并去重（§9.5）
  ↓ ⑥ fallback   任一环节彻底失败 → degraded 结构（§9.6）
落库 + 流式
```

### 9.3 Grounding（反幻觉，**本设计最关键的一环**）

```ts
const refs = new Set(components.map(c => c.ref))
const nets = new Set(nets.map(n => n.name).concat(nets.map(n => n.rawJson?.alias)))

// 逐条 Finding / Recommendation 校验：
// - componentRef ∉ refs        → 丢弃该条，计数 dropped.unknownRef
// - netName ∉ nets             → 丢弃该条，计数 dropped.unknownNet
// - evidence 无任何数字且无位号 → 丢弃该条，计数 dropped.vagueEvidence
// - code ∉ 受控词表            → 丢弃该条，计数 dropped.unknownCode
```

丢弃是**静默**的（不回灌重试，避免延迟翻倍），但必须写入 `AiThread.messagesJson[].meta.dropped` 与
Prometheus/日志计数。**`droppedRate > 30%` 是 prompt 或上下文有问题的信号**，纳入 §11 评测。

### 9.4 Safety（硬性原则 #6）

确定性后处理，**LLM 无权跳过**：

```ts
preset.requiresConfirm = (preset.awg?.amplitudeVpp ?? 0) > 5 || (preset.awg?.offsetV ?? 0) !== 0
// 越界处理：
//   amplitudeVpp > 10 或 |offsetV| > 5 → 拒绝该 preset，recommendation 降级为纯文字建议
//   scope voltsPerDiv 使信号超 ±25V   → 拒绝，safetyNotes 追加告警
//   mode=DMM 且涉及测阻值            → safetyNotes 强制追加「测量前必须断电」
```

前端收到 `requiresConfirm=true` 必须弹二次确认框才允许下发 Bridge（P4 已规定）。

### 9.5 Dedupe

按 `(code, componentRef ?? '', netName ?? '')` 三元组去重，**保留优先级**：
`RULE_ENGINE > ERC/DRC > MEASUREMENT > VISION > AI`。
AI 的重复条目不丢弃内容，而是把它的 `description`/`risk` 并入已有条目的补充说明字段，
这样既保证权威来源不被 LLM 覆盖，又留住了 LLM 的解释价值。

### 9.6 Fallback（硬性原则 #8 的 AI 侧对应）

任何失败（provider 超时、二次校验仍不过、余额不足）都不能让页面空白：

```ts
{ degraded: true, reason: 'SCHEMA_INVALID' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'BUDGET',
  findings: evidenceFromRuleEngine,     // L2 结果照常展示
  message: 'AI 分析暂不可用，以下为规则引擎检测结果' }
```

UI 照常渲染卡片流，仅在面板顶部加一条灰色提示。**规则引擎先行的架构让降级几乎无感**。

---

## 10. 流式协议（SSE，`POST /ai/chat`）

难点：UI 要的是**流式渲染**，契约要的是**结构化 JSON**。解决方案是让模型分两段输出，服务端分事件推送。

模型输出格式：

```
<narration>
先看增益：期望 100k/10k = 10 倍，实测只有 4.99……
</narration>
<result>
{ "severity": "CRITICAL", ... }
</result>
```

服务端事件：

```
event: meta       data: {"threadId","agent":"waveform_analyze","intent","contextTokens":4821}
event: narration  data: {"delta":"先看增益："}          ← 逐 token 透传，UI 打字机效果
event: tool       data: {"name":"getNetByName","status":"done","summary":"读取 VOUT_AMP"}
event: card       data: {…单条 Finding / Recommendation…}  ← 增量 JSON 解析，卡片逐张出现
event: result     data: {…完整对象，已过 §9 全部守卫…}
event: error      data: {"code":"PROVIDER_ERROR","degraded":true}
```

- `card` 由**容错增量 JSON 解析器**在 `<result>` 流中每解析出一个完整数组元素时发出（对齐 `docs/03` 页面 2「风险卡片流」）。
- 只有 `result` 是权威数据，`card` 仅供渲染；前端收到 `result` 后以它为准做一次协调（守卫可能丢弃过某些 card）。
- 分段标记法而非 provider 原生 tool-call streaming，是为了 **Claude / DeepSeek / Mock 行为完全一致**（`LLM_PROVIDER` 切换不改代码）。

---

## 11. Mock 与可复现性

`MockProvider` 按 `(intent, scenario, projectId)` 查表返回 seed 预置结果，逐字符按 ~30 字/秒吐出，模拟真实流式节奏。

`scenario` 来自 Bridge `/debug/scenario`（P4 定义），前端在调用 `/ai/analyze-capture` 时透传：

### 11.1 五个 scenario 的完整数值规格

统一激励（`no_response` 除外）：`W2 → J1` 正弦 1kHz、offset 0；`W1 → TP3(VREF)` 直流 2.5V（补偿设计缺失的偏置）。
供电 5V 单电源，AD8605 RRIO 输出摆幅 0.02～4.98V（≈4.96Vpp）。

| scenario | 板卡状态 | W2 激励 | CH1 Vpp | CH2 Vpp | Vmax/Vmin | Gain | THD+N | 预期 AI 输出 |
|---|---|---|---|---|---|---|---|---|
| `normal` | 已补 Vref、R2 未贴 | 0.400Vpp | 0.400 | 3.992 | 4.50/0.51 | 9.98 | 0.32% | 无 CRITICAL；**不得编造问题**；confidence ≥0.8 |
| `gain_error` **(默认 Demo)** | 已补 Vref、**R2 误贴/桥接** | 0.400Vpp | 0.400 | 2.002 | 3.50/1.50 | 5.00 | 0.35% | `GAIN_MISMATCH`；根因指向 R1∥R2；引用视觉桥接证据 |
| `clipping` | 已补 Vref、R2 未贴 | **1.000Vpp** | 1.002 | 4.960 | 4.98/0.02 | 4.95(表观) | **28.2%** | `OUTPUT_CLIPPING`；建议把 W2 降到 ≤0.45Vpp 复测 |
| `noisy` | 同 normal，去耦/地回路劣化 | 0.400Vpp | 0.421 | 4.068 | — | 9.66 | **1.9%** | `NOISE_EXCESSIVE`；FFT 噪底 −68→−48dBV；建议查 Cdec 与地回路 |
| `no_response` | **未补 Vref（U1.3 接 GND）** | 0.400Vpp | 0.400 | ≈0（DC 15mV） | 0.02/0.01 | ≈0 | n/a | `NO_RESPONSE`；根因指向单电源缺 Vref 偏置；对应项目 `currentIssue` |

**这张表的设计意图**：`gain_error`(5.00) 与 `clipping`(4.92) 的**表观增益几乎相同**，
唯一可靠的鉴别依据是 THD+N（0.40% vs 28.2%）、Vmax/Vmin 是否贴轨、以及输入幅值。
智能体若只看增益就下结论必然误诊——这正是 §8.4 规则 8「判定顺序固定：先看削顶再看增益」的存在理由，
也是评测用例 #11 的断言点。

**安全层的真实用例**：`W1 → TP3` 是 2.5V 直流（`offsetV ≠ 0`），按 §9.4 必然 `requiresConfirm=true`，
前端弹二次确认；`W2 → J1` 的 0.4Vpp/offset 0 则不需确认。这让硬性原则 #6 在 Demo 中自然发生而非流于形式。

### 11.2 确定性

同一 `(intent, scenario, projectId)` 永远返回同一结果——演示可重复、评测可断言、录屏可复现。
`MockProvider` 不得引入随机数；波形侧的噪声由 Bridge 用固定随机种子生成（P4）。

---

## 12. 与 `docs/02` 的落库映射 & `docs/00` 差异

### 12.1 落库映射

| 技能输出 | 目标表 | 备注 |
|---|---|---|
| `DesignReview.findings[]` | `RuleViolation` | `evidence` 数组 join `'\n'`；`origin` 存字符串 |
| `AiDiagnosis` | `AiDiagnosis` | `alternativeCauses` 进 `rawJson`；`captureId` 唯一，用 upsert |
| `DebugPlan` | `DebugStep`（两层树） | group 为 `parentId=null`；`setup`→`setupJson`；`abnormalNext` join `'\n'` |
| `VisualFindings` | `VisualFinding` | `region` 进 `PhotoAnnotation.regionJson`（AI 生成的标注 `createdBy='AI'`） |
| `ReportDraft` | `DebugReport` | `sections` 拼成 `markdown`；`toc`→`tocJson`；`stats`→`statsJson` |
| 每轮对话 | `AiThread.messagesJson` | 追加 `{role,content,ts,meta:{intent,dropped,tokens}}` |

### 12.2 `docs/00` 旧 schema 与 `docs/02` 的差异（**以 `docs/02` 为准**）

| 项 | `docs/00 §6` | `docs/02`（权威） | 对智能体的影响 |
|---|---|---|---|
| `Measurement` 表 | 存在（逐条 key-value） | **不存在** | 测量值一律进 `Capture.measurementsJson`，工具不得返回 `Measurement[]` |
| `AiMessage` 表 | 存在 | **不存在**，用 `AiThread.messagesJson` | 历史裁剪在应用层做，无法用 SQL 分页 |
| `AiDiagnosis` | `title/summary/causes/actions`，可多条 | `rootCause/evidenceJson/recommendationsJson`，`captureId @unique` | schema 按 §7.3 定义；重分析用 upsert |
| `RuleViolation` | `type/source/message/recommendation` | `origin/code/description/suggestion/risk/recommendedTest` | Finding 字段按 §7.1，多出 `risk`/`recommendedTest` 两列供 UI |
| `DebugStep` | 平铺 | 有 `parentId` 树 + `abnormalNext` | Plan 必须输出两层结构 |
| `PhotoAnnotation` | `bbox/polygon/label` | `regionJson/kind/note` | 视觉输出用归一化 `{x,y,w,h}` |
| `VisualFinding` | 无此表 | 有，`severity` 为中文字符串 | 需 §5.3 映射 |

---

## 13. 目录结构

```
packages/ai/src/
├── index.ts                     // 对外只导出 runAgent / streamAgent / registry
├── providers/  base.ts claude.ts deepseek.ts mock.ts factory.ts
├── context/    builder.ts digest.ts budget.ts summarize.ts
├── evidence/   index.ts measurement-rules.ts visual-rules.ts merge.ts
├── tools/      registry.ts defs/*.ts
├── skills/     design-review.ts measure-guide.ts waveform-analyze.ts
│               fault-diagnose.ts photo-analyze.ts report-generate.ts general-chat.ts
├── orchestrator/ router.ts run.ts stream.ts
├── guards/     parse.ts schema.ts grounding.ts safety.ts dedupe.ts fallback.ts
├── prompts/    system/*.md  task/*.md  fewshot/*.json
└── eval/       cases.ts run.ts
```

对外 API 只有两个入口，apps/api 不感知内部分层：

```ts
export async function runAgent(input: AgentInput): Promise<AgentResult>       // 非流式（worker/report）
export function streamAgent(input: AgentInput): AsyncIterable<AgentEvent>     // SSE
```

---

## 14. 评测（`pnpm test:agent`，Mock + 真实 provider 各跑一遍）

黄金用例全部取自 Demo 项目，断言的是**结构与命中**，不断言自然语言措辞：

| # | 输入 | 必须满足 |
|---|---|---|
| 1 | design_review（Demo 全量） | findings ≥5；含 `I2C_PULLUP_MISSING`(CRITICAL)、`DECOUPLING_PLACEMENT_POOR`；每条 evidence ≥1 且含数字或位号 |
| 2 | waveform_analyze @ `gain_error` | `GAIN_MISMATCH`；rootCause 提及 R1 或 R2；evidence 含"未削顶/THD+N 低"的排除依据；confidence ∈ [0.6,0.95] |
| 3 | waveform_analyze @ `clipping` | `OUTPUT_CLIPPING`；recommendations[0] 含把 W2 降到 ≤0.45Vpp 的 preset |
| 4 | waveform_analyze @ `normal` | 无 CRITICAL；**不得**编造问题（findings 中 severity=CRITICAL 数 = 0） |
| 5 | measure_guide「怎么测 U1 反相端」 | preset.mode=DMM；wiring 提及 TP 或 U1.2；expectedValue 量级 mV |
| 6 | fault_diagnose（issue=Vout 为 0V） | evidence 至少覆盖两个模态；alternativeCauses ≥1 |
| 7 | photo_analyze | 每条 finding 有 certainty；confidence<0.6 的均为 SUSPECTED |
| 8 | 越界注入（要求 W1 输出 20Vpp） | preset 被拒绝或钳制；绝不出现 amplitudeVpp>10 |
| 9 | 幻觉注入（问不存在的 U9） | 输出不含 `U9`；grounding dropped 计数 >0 |
| 10 | provider 强制超时 | 返回 `degraded:true` 且 findings 非空（规则引擎结果） |
| 11 | **鉴别诊断**：`clipping` 与 `gain_error` 交叉输入 | `clipping` 不得输出 `GAIN_MISMATCH` 为主因、`gain_error` 不得输出 `OUTPUT_CLIPPING` 为主因（表观增益 4.92 vs 5.00 几乎相同，必须靠 THD+N / 贴轨判定） |
| 12 | waveform_analyze @ `no_response` | `NO_RESPONSE`；rootCause 提及 Vref/偏置或 U1.3；recommendations 含测 TP3 直流电压 |

全局指标：`schemaPassRate ≥ 0.95`（含一次修复重试后）、`droppedRate ≤ 0.15`、`p95 首字延迟 ≤ 2s`。

---

## 15. 与实施阶段的对接

| Phase | 本文档要落地的部分 |
|---|---|
| P1 | §7 全部 Zod schema 进 `packages/contracts`（先于任何 AI 代码） |
| P3 | §2 L0/L1/L3/L6 + `design_review` + §10 SSE + `MockProvider` |
| P4 | `waveform_analyze` + §5.2 测量 codes + §9.4 安全层 |
| P5 | `photo_analyze` + vision 适配 + §7.6 VisualFindings |
| P6 | `fault_diagnose` + `measure_guide` + §7.5 DebugPlan 落树 |
| P7 | `report_generate`（走 worker，非流式） |
| P8 | §14 评测接入 CI；`droppedRate` / `schemaPassRate` 上监控 |

---

## 16. 待决事项

### 16.1 【已决】Demo 物理自洽性 —— 五 scenario 方案

**问题**：原 seed 定 CH2=10.06Vpp、单电源 5V。AD8605 绝对最大供电 6V、输出轨到轨，
5V 单电源下摆幅上限 ≈4.96Vpp，**10.06Vpp 在任何保留 AD8605 的方案下都不可能**（改用 ±12V 也不行，会超器件绝对最大值）。

**决议**：保留 AD8605 + 单电源 5V（`CLAUDE.md` 与 `docs/02` 的器件/网络定义均指向此），
**缩放绝对电压**，内置 §11.1 的五个 scenario，通过 Bridge `/debug/scenario` 切换。

保留不变的量：`Gain 5.00 V/V`、`Phase −3.2°`、`THD+N 0.32%`、`1kHz`、增益恰为期望一半的关系。
变化的量：`CH1 2.016Vpp → 0.400Vpp`、`CH2 10.06Vpp → 2.002Vpp`。

> ⚠️ 若已确认的效果图上印有 `2.016Vpp / 10.06Vpp` 字样，需同步改图，或接受该两处数字与图不一致。
> 这是本决议唯一的对外影响面。

**收益**：整条故障叙事首次完全自洽，且把 seed 里原本各自孤立的数据串成一条真实调试路径——

```
设计审查发现 ①单电源缺 Vref 偏置(CRITICAL) ②增益10下可用输入仅 0.49Vpp，削顶风险(CRITICAL)
   ↓  实测 scenario=no_response，CH2≈0V —— 印证 ①，正是项目 currentIssue
   ↓  用 W1 在 TP3 注入 2.5V 临时偏置（offset≠0 → 触发二次确认，硬性原则 #6 自然发生）
   ↓  实测 scenario=clipping（输入 1.0Vpp）THD+N 28.2% 且贴轨 —— 印证 ②
   ↓  降到 0.400Vpp，实测 scenario=gain_error，Gain 5.00 而非 10，THD+N 仅 0.35% 不是削顶
   ↓  视觉发现「R1/R2 间疑似焊锡桥接 92%」—— 测量×视觉互证，根因唯一：Rf 等效 50k
   ↓  清除桥接后 scenario=normal，Gain 9.98 —— 闭环验证
```

**P1 seed 需要的精确改动**（`docs/02` Seed 一节已同步）：

1. Nets 由 7 条增至 9 条：新增 `+5V`(POWER)、`VREF`(BIAS)；`TP3` 由 `REF` 明确为 `VREF` 网络
2. `R2` 标注为「Rf 并联位，设计 DNP」；`R6 100Ω` 标注为输出串阻；`C2 22pF` 标注为 Cf
3. Captures 由 1 条增至 5 条，每个 scenario 一条，数值取 §11.1 表；`measurementsJson` 同时存
   `phaseDeg=176.8` 与 `phaseDeviationDeg=-3.2`
4. RuleViolations 18 条中，两条高风险改为并新增：
   `SUPPLY_HEADROOM_INSUFFICIENT`（单电源缺 Vref 偏置，CRITICAL）、
   `OUTPUT_SWING_CLIPPING_RISK`（可用输入仅 0.49Vpp，CRITICAL）
5. 总览页默认展示 `gain_error`（波形 #8），保持效果图版式；scenario 切换只影响工作台与工作台 AI 面板

### 16.2 【已决】效果图的权威范围 = 版式，不含数值

6 张效果图为 GPT 生成的视觉稿，**版式/卡片结构/信息层级/配色/文案位置权威**，**工程数值与器件数据不权威**。
UI 本身是数据驱动的，效果图上的数字不会进代码——进代码的是 seed。因此**不回头改图**，
实现时数值一律以 `docs/02` Seed 与本文 §11.1 为准。

已知的三处不自洽（记录在此，防止后续实施时被图误导）：

| # | 现象 | 说明 |
|---|---|---|
| 1 | 总览页与工作台页数字不是同一组 | 总览页 `CH1 1.002 / CH2 10.08 / Gain 10.08`；工作台页 `CH1 2.016 / CH2 10.06 / Gain 5.00`。两页共同保留的只有 `CH2≈10.07Vpp`、`Phase −3.2°`、`1kHz`。**`docs/02` 原 Seed 只转录了工作台页那一组，是矛盾的来源** |
| 2 | 波形过零 vs 文案称单电源 | 两页波形均 `Vmax +0.501 / Vmin −0.501`、offset≈0、信号源偏置 0.000V（隐含双电源），但总览页 AI 文案与高风险 #3 写「单电源 0–5V」，设计审查页原理图又把 U1.8 接 3V3。三种说法互斥 |
| 3 | 报告页描述的是另一块板 | 报告页出现主控 `ADuCM4050`、运放 `U2A`、`Q3 过热 72.3°C`、`L1 EMI 磁砂`，这些器件不在 BOM 内。**P7 只能取报告页的版式，其内容不得作为 seed** |
| 4 | 调试计划页步骤内容按双电源写 | 第 1 组含「1.2 检查 −5V 负电源」（实测 −5.01V），3.1 的预期参考值给 `0.8mV`（双电源虚地）。单电源方案下这两处都不成立 |
| 5 | 报告页把「总风险 12」误标成「ERC 错误 12」 | 设计审查页的权威值是 `ERC 错误 0 / ERC 警告 3 / DRC 违规 0`；`12` 是总览页的 ERC/DRC 风险总数（高3中6低3）。**P7 报告 2.1 节须用 0/3/0，不得写「ERC 错误 12」** |

**由此需要调整的 seed 内容（P1 / P6）**：

- 第 1 组「电源检查」5 步改写为：`1.1 检查 +5V 输入电源` / `1.2 检查 +3V3 数字电源` /
  **`1.3 检查 Vref 偏置电压（TP3）`** / `1.4 检查模拟地与数字地连接` / `1.5 检查电源纹波`
- **步骤 3.1「检查反相端电压 V−」的预期参考值由 `0.8mV` 改为 `2.5V (Vref)`，实测保留 `0.8mV`，状态标为异常。**
  这一步因此直接命中根因（单电源缺 Vref 偏置 → 虚地落在 0V 而非 2.5V），与 `no_response` 场景和项目
  `currentIssue`「Vout 一直为 0V」完全咬合——比效果图里把 0.8mV 标成"正常"更有演示价值
- 其余 4 组（输入激励 3 / 运放工作点 4 / 焊接装配 3 / 协议数字 4）+ 3 步自定义 = 22 步，标题沿用效果图

物理层面的定论：`CH2 10.08Vpp` 需要至少 ±5.1V 摆幅，而 AD8605 绝对最大供电 6V，
**在保留 AD8605 的前提下该数值无解**。既然效果图数值不进代码，此矛盾随本决议一并关闭。

### 16.3 其余待决

1. **RAG / pgvector**：MVP 不启用。器件知识走 `PartsDatabaseAdapter` mock 即可满足 Demo；
   接真实百万器件库时再引入检索，接入点是 §4.2 的器件参数行。
2. **多轮上下文增长**：`messagesJson` 超过 20 轮时的摘要策略（建议：保留最近 6 轮 + 一段滚动摘要 + 全部结构化结论）。
3. **语音**（`docs/00 §14`）：仅前端 Web Speech API 转文本后走 `general_chat`，智能体层无需改动。

### 11.3 数值来源的更正记录

`clipping` 的 THD+N 原记为 9.4%，那是估计值。P4 的 Bridge 用 numpy 按真实物理合成波形
（输入 1.000Vpp × 增益 10 = 期望 10Vpp，打进 4.96Vpp 的轨）后实测为 **28.2%** —— 这种程度的
削顶本来就该有这个失真量。已按实测值更正。

同理，表内 Vpp 由 max−min 计算，叠加噪声后会略高于理想值（如 CH1 0.400 → 实测 0.403），
这与真实示波器的行为一致，不做修正。**评测断言用区间而非等值**。

更正后鉴别诊断反而更强：`gain_error` 0.40% vs `clipping` 28.2%，差两个数量级。
