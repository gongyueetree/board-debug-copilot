# 02 数据模型（Prisma）

关系不可改，字段可细化。波形原始数组不入库（存对象存储，`Capture.waveformObjectKey` 引用）。

> **纪律更新（P9 起）**：「关系不可改」是 P0–P8 的冻结约定。从 P9 起改为：
> **先改本文档，再改 schema，再写迁移，三者同一个 commit。** 禁止只改 schema
> 不改文档 —— 文档与 schema 漂移之后，这份文档就从「权威定义」退化成「历史记录」。
>
> P9 只加列加表，不动任何既有关系。P11 / P12 会真正改关系，届时按上面的顺序走。

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum ProjectStatus { CREATED UPLOADED PARSING READY ERROR }
enum FileKind { KICAD_ZIP KICAD_PROJECT SCHEMATIC PCB BOM NETLIST ERC_REPORT DRC_REPORT PCB_PHOTO CAPTURE_FILE REPORT OTHER }
enum CaptureKind { OSCILLOSCOPE FFT BODE LOGIC DMM POWER }
enum DiagnosisSeverity { INFO WARNING CRITICAL }
enum StepStatus { PENDING IN_PROGRESS COMPLETED FAILED SKIPPED }

// ── P9 器件库 ─────────────────────────────────────────────────
enum PartCategory { OPAMP LDO DCDC ADC DAC MCU FPGA MEMORY RESISTOR CAPACITOR INDUCTOR
                    DIODE LED MOSFET BJT CRYSTAL CONNECTOR SENSOR TRANSCEIVER OTHER }
enum PartLifecycle { ACTIVE NRND EOL OBSOLETE UNKNOWN }
enum MatchMethod   { EXACT PREFIX PARAMETRIC VECTOR MANUAL }
enum MatchStatus   { UNMATCHED MATCHED NEEDS_REVIEW REJECTED }

model User {
  id String @id @default(uuid())
  email String? @unique
  name String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  projects Project[]
}

model Project {
  id String @id @default(uuid())
  userId String?
  name String
  description String?
  status ProjectStatus @default(CREATED)
  currentIssue String?          // 当前调试问题描述（调试计划页顶部）
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user User? @relation(fields: [userId], references: [id])
  files ProjectFile[]
  components Component[]
  nets Net[]
  testPoints TestPoint[]
  photos BoardPhoto[]
  captures Capture[]
  debugSteps DebugStep[]
  aiThreads AiThread[]
  reports DebugReport[]
  violations RuleViolation[]
}

model ProjectFile {
  id String @id @default(uuid())
  projectId String
  kind FileKind
  filename String
  objectKey String
  mimeType String?
  sizeBytes Int?
  checksum String?
  parseStatus String?
  parseLog String?
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model Component {
  id String @id @default(uuid())
  projectId String
  ref String
  value String?
  symbol String?
  footprint String?
  partNumber String?
  manufacturer String?
  datasheetUrl String?
  x Float?  y Float?  rotation Float?  side String?
  rawJson Json?
  partId String?                              // P9：匹配到的器件库条目
  matchStatus MatchStatus @default(UNMATCHED) // P9：由确定性层写入，不靠 prompt
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  part Part? @relation(fields: [partId], references: [id])
  pins Pin[]
  bomMatches PartMatch[]
  testPoints TestPoint[]
  photoAnnotations PhotoAnnotation[]
}

model Pin {
  id String @id @default(uuid())
  componentId String
  number String
  name String?
  type String?
  netId String?
  component Component @relation(fields: [componentId], references: [id], onDelete: Cascade)
  net Net? @relation(fields: [netId], references: [id])
}

model Net {
  id String @id @default(uuid())
  projectId String
  name String
  netClass String?
  inferredRole String?       // POWER/GND/SIGNAL/I2C/...
  expectedVoltage String?
  expectedFrequency String?
  rawJson Json?
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  pins Pin[]
  testPoints TestPoint[]
  captures Capture[]
}

model TestPoint {
  id String @id @default(uuid())
  projectId String
  componentId String?
  netId String?
  label String               // TP1/TP2/TP3...
  description String?
  x Float?  y Float?
  source String              // KICAD / USER / AI
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  component Component? @relation(fields: [componentId], references: [id])
  net Net? @relation(fields: [netId], references: [id])
}

model PartMatch {
  id String @id @default(uuid())
  componentId String
  source String              // MOCK / REAL_DB —— 保留做历史数据兼容
  externalPartId String?
  matchedPartNumber String?
  confidence Float?
  summaryJson Json?
  method MatchMethod @default(EXACT)   // P9：命中在第几层
  accepted Boolean @default(false)     // P9：confidence < 0.6 时为 false，等人确认
  reviewedBy String?                   // P9：人工确认者
  reviewedAt DateTime?
  component Component @relation(fields: [componentId], references: [id], onDelete: Cascade)
}

// ── P9 器件库镜像 ─────────────────────────────────────────────
// 只镜像「项目真正用到的」+ 预热脚本拉的高频器件。110 万条不全量导入：
// 没必要也难维护，而且全量导入之后 TTL 刷新会变成一个独立的运维负担。
model Part {
  id String @id @default(uuid())
  mpn String @unique          // 归一化后（大写、去分隔符）
  rawMpn String               // 原始串，展示用
  manufacturer String?
  category PartCategory @default(OTHER)
  description String?
  packageCase String?
  datasheetUrl String?
  lifecycle PartLifecycle @default(UNKNOWN)
  rohs Boolean?
  paramsJson Json @default("{}")   // 含 __meta.complete / missing / parser
  commercialJson Json?             // 价格库存，与 params 分离，不进 prompt
  sourceProvider String
  sourceId String?
  fetchedAt DateTime @default(now())
  expiresAt DateTime?              // TTL；过期后异步刷新，先返回旧值
  components Component[]
  alternates PartAlternate[] @relation("PartAlternates")
  knowledge PartKnowledge?
  @@index([category])
  @@index([manufacturer])
  @@index([expiresAt])
}

model PartAlternate {
  id String @id @default(uuid())
  partId String
  altMpn String
  kind String                 // PIN2PIN / FUNCTIONAL / UPGRADE
  confidence Float
  reason String?
  part Part @relation("PartAlternates", fields: [partId], references: [id], onDelete: Cascade)
  @@unique([partId, altMpn])
}

model RuleViolation {
  id String @id @default(uuid())
  projectId String
  origin String              // RULE_ENGINE / ERC / DRC / AI
  code String                // e.g. DECOUPLING_INSUFFICIENT
  severity DiagnosisSeverity
  title String
  description String
  evidence String?
  risk String?
  suggestion String?
  recommendedTest String?
  componentRef String?
  netName String?
  resolved Boolean @default(false)
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model BoardPhoto {
  id String @id @default(uuid())
  projectId String
  objectKey String
  side String?               // TOP / BOTTOM
  alignmentJson Json?        // 板框对齐/定位孔/映射结果（PCB照片页）
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  annotations PhotoAnnotation[]
  visualFindings VisualFinding[]
}

model PhotoAnnotation {
  id String @id @default(uuid())
  photoId String
  componentId String?
  netName String?
  kind String                // component / solder / damage / question
  regionJson Json            // {x,y,w,h} 归一化坐标
  note String?
  createdBy String?
  createdAt DateTime @default(now())
  photo BoardPhoto @relation(fields: [photoId], references: [id], onDelete: Cascade)
  component Component? @relation(fields: [componentId], references: [id])
}

model VisualFinding {
  id String @id @default(uuid())
  photoId String
  code String                // SOLDER_BRIDGE / MISSING_PART / POLARITY / ORIENTATION / JOINT_QUALITY
  title String
  detail String
  confidence Float
  severity String            // 高风险/中风险/低风险/正常（对齐UI）
  componentRef String?
  createdAt DateTime @default(now())
  photo BoardPhoto @relation(fields: [photoId], references: [id], onDelete: Cascade)
}

model Capture {
  id String @id @default(uuid())
  projectId String
  netId String?
  kind CaptureKind
  label String?
  hardwareSetupJson Json     // W1/CH1/CH2/timebase/sampleRate/trigger/coupling
  measurementsJson Json      // vpp,vrms,freq,gain,phase,offset,thdn（摘要）
  waveformObjectKey String?  // 原始数组存对象存储
  thumbnailObjectKey String?
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  net Net? @relation(fields: [netId], references: [id])
  diagnosis AiDiagnosis?
  debugStepId String?
  debugStep DebugStep? @relation(fields: [debugStepId], references: [id])
}

model AiDiagnosis {
  id String @id @default(uuid())
  captureId String? @unique
  projectId String
  severity DiagnosisSeverity
  rootCause String
  confidence Float
  evidenceJson Json          // string[]
  recommendationsJson Json   // {action,order}[]
  rawJson Json?
  createdAt DateTime @default(now())
  capture Capture? @relation(fields: [captureId], references: [id])
}

model DebugStep {
  id String @id @default(uuid())
  projectId String
  parentId String?           // 分组树（电源检查/输入激励检查/...）
  order Int
  title String
  objective String?
  toolHint String?           // 万用表/示波器/ADALM2000/逻辑分析仪/目视
  estimateMin Int?
  setupJson Json?            // 连接与设置（对齐调试计划页步骤详情）
  targetNet String?
  targetComponent String?
  expectedResult String?
  abnormalNext String?       // 异常情况与下一步
  status StepStatus @default(PENDING)
  resultJson Json?           // 实测值/结论
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent DebugStep? @relation("StepTree", fields: [parentId], references: [id])
  children DebugStep[] @relation("StepTree")
  captures Capture[]
}

model AiThread {
  id String @id @default(uuid())
  projectId String
  mode String                // design_review / bench / photo / plan / general
  messagesJson Json          // [{role,content,ts}]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model DebugReport {
  id String @id @default(uuid())
  projectId String
  title String
  version String @default("v1.0")
  author String?
  coverObjectKey String?
  markdown String            // 报告正文
  tocJson Json?              // 目录结构（报告页左侧）
  statsJson Json?            // 问题总数/已解决/优化建议/测量数/AI建议
  createdAt DateTime @default(now())
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}
```

## Seed（必须实现）

> 数值规格与故障叙事以 `docs/05-agent-design.md` §11.1 / §16.1 为准（五 scenario 方案，已解决原 seed 的物理不自洽）。

`Sensor Board Debug Demo` 完整数据：
- Components: U1 AD8605(SOIC-8，单电源 5V，RRIO)、U2 MCP4725、U3 TPS7A02、R1 100k(Rf)、R2 100k(Rf 并联位，设计 DNP)、R3 10k(Rin)、R4/R5 4.7k(I2C 上拉)、R6 100Ω(输出串阻)、C1 10uF、C2 22pF(Cf)、C3 1uF、C4 100nF、Cdec 100nF×6、J1 VIN、J2 VOUT、TP1–TP4（TP3=VREF）
- Nets（9 条）: VIN_SENS、VOUT_AMP、VREF、+5V、3V3、GND、SDA、SCL、U1_IN-（N0012）
- RuleViolations（对齐总览页高风险列表）：单电源缺 Vref 偏置 `SUPPLY_HEADROOM_INSUFFICIENT`(高)、输出摆幅削顶风险 `OUTPUT_SWING_CLIPPING_RISK`(高，可用输入仅 0.49Vpp)、I2C上拉缺失(高)、去耦电容位置不佳(中)、输入偏置电流影响(中)、地参考不连续(中)，共 18 条含低风险
- Captures（5 条，对应 5 个 scenario，数值见 `docs/05` §11.1）；总览页与效果图默认展示 `gain_error` 波形 #8：
  CH1 0.400Vpp / CH2 2.002Vpp / Gain 5.00 / Phase −3.2°（`phaseDeg=176.8` 与 `phaseDeviationDeg=-3.2` 同时入库）/ THD+N 0.35%
- DebugSteps: 5 组 22 步（电源检查5 / 输入激励3 / 运放工作点4 / 焊接装配3 / 协议数字4 + 自定义3），3.1 步骤含完整 setupJson。
  第 1 组按单电源改写（+5V / +3V3 / **Vref 偏置(TP3)** / 模拟地-数字地 / 电源纹波，无 −5V 负电源步骤）；
  **3.1「检查反相端电压 V−」预期参考值 2.5V(Vref)、实测 0.8mV、状态异常**——直接命中根因，详见 `docs/05` §16.2
- VisualFindings: 疑似焊锡桥接92%高、可能缺少电容88%中、连接器极性99%正常、芯片方向98%正常、焊点质量75%低
- DebugReport 一份（对齐报告页统计：3问题/2已解决/1优化建议/8测量/5AI建议）
