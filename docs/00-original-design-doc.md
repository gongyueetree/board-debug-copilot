# Claude Code 实施设计文档
# Board Debug Copilot / 准 LabSight 原型网站

版本：v0.1  
目标读者：Claude Code / 全栈开发工程师 / AI 工程师 / KiCad 工程解析工程师  
项目目标：实现一个基于 KiCad 工程文件、ADALM2000 测试测量数据、PCB 照片、大模型和元器件数据库的板级调试智能体原型网站。

---

## 0. 一句话目标

构建一个可部署在 Vercel / Railway 上的准 LabSight 原型系统：

> 工程师上传 KiCad 压缩工程文件和 PCB 照片，系统解析原理图、PCB、BOM、Netlist、ERC/DRC；用户通过本地 ADALM2000 Bridge 控制 ADALM2000 产生信号、采集信号；AI 智能体结合设计工程、元器件数据库、PCB 照片和测试测量数据，给出设计审查、调试步骤、故障诊断、测量解释和调试报告。

---

## 1. 产品范围

### 1.1 MVP 必须完成

MVP 的目标不是完整替代 LabSight，也不是完整替代 Scopy，而是完成一个可演示、可扩展的闭环：

1. 用户创建调试项目；
2. 上传 KiCad `.zip` 工程；
3. 后端解析工程文件，生成文件树、原理图预览、PCB 预览、BOM、Netlist、ERC 结果、DRC 结果、组件、网络、引脚、测试点数据；
4. 用户上传 PCB 实物照片；
5. 用户可以在照片上手动标注器件、测试点和问题区域；
6. 系统连接本地 ADALM2000 Bridge；
7. 支持 ADALM2000 的基础能力：设备状态、W1 信号源、CH1/CH2 示波器采集、基础测量、FFT 基础分析；
8. AI 智能体可读取当前项目上下文，回答原理图风险、器件选型、网络测量、ADALM2000 接线设置、当前波形异常和下一步调试建议；
9. 保存调试记录；
10. 生成调试报告。

### 1.2 MVP 不做或仅留接口

以下内容暂不实现完整功能，只保留抽象接口或 mock：

- 自动摄像头实时识别；
- 全自动 PCB 照片与 KiCad PCB 精确配准；
- 完整 KiCad 在线编辑；
- 自动修改原理图/PCB；
- 完整多仪器系统；
- 复杂 SI/PI 分析；
- 完整协议分析仪；
- 自动生成 Gerber 修改建议；
- 真实大规模 100 万元器件数据库全量接入，可先用 mock adapter；
- 企业级多租户权限，可先做单用户/简单登录。

---

## 2. 用户故事

### 2.1 上传工程并获得设计摘要

作为工程师，我希望上传一个 KiCad 工程压缩包，系统自动识别工程结构，提取原理图、PCB、BOM 和 Netlist，并给出一个设计摘要。

验收标准：

- 支持上传 `.zip`；
- 能识别 `.kicad_pro`、`.kicad_sch`、`.kicad_pcb`；
- 能显示工程文件树；
- 能显示器件列表；
- 能显示网络列表；
- 能给出 AI 项目摘要；
- 解析失败时显示明确错误。

### 2.2 基于原理图进行 AI 设计审查

作为工程师，我希望 AI 检查原理图中潜在问题，例如电源、上拉、去耦、运放反馈、接口保护等。

验收标准：

- AI 可读取结构化 Component / Net / ERC；
- 输出问题列表；
- 每个问题包含问题描述、证据、风险、建议、推荐测量点和严重级别；
- 不允许 AI 只输出泛泛建议。

### 2.3 使用 ADALM2000 进行可执行调试

作为工程师，我希望 AI 告诉我如何用 ADALM2000 测某个信号，包括 W1 输出什么、CH1/CH2 接到哪里、时基/采样率/触发如何设置。

验收标准：

- AI 可以生成调试步骤；
- 每个步骤包含测量目标、接线方式、ADALM2000 设置、预期结果、异常判断；
- 用户可以一键把参数发送给 Bridge；
- 危险操作前必须确认。

### 2.4 结合当前波形解释故障

作为工程师，我希望 AI 根据当前采集到的信号参数和设计上下文，判断当前问题更可能来自哪里。

验收标准：

- Bridge 返回测量摘要；
- 系统保存 capture；
- AI 分析 capture + net + component + user question；
- 输出诊断结论和下一步建议；
- 诊断结果可保存到调试记录。

### 2.5 上传 PCB 照片辅助诊断

作为工程师，我希望上传 PCB 照片，AI 可以辅助发现焊接、装配或明显布局问题。

验收标准：

- 支持上传照片；
- 支持手动标注区域；
- AI 可以针对照片回答；
- 结果必须区分“确定问题”和“疑似问题”；
- 可把照片标注关联到器件、网络或调试步骤。

---

## 3. 总体架构

### 3.1 推荐部署

```text
Vercel
└── apps/web
    ├── Next.js UI
    ├── 项目空间
    ├── KiCad 预览
    ├── PCB 照片标注
    ├── ADALM2000 面板
    ├── 波形视图
    └── Debug Copilot

Railway
├── apps/api
│   ├── REST API
│   ├── AI Orchestrator
│   ├── Project Service
│   ├── KiCad Service
│   ├── Capture Service
│   └── Report Service
├── apps/worker
│   ├── KiCad CLI Worker
│   ├── ERC/DRC Parser
│   ├── BOM Matcher
│   ├── Embedding Worker
│   └── Report Worker
├── PostgreSQL + pgvector
├── Redis
└── Object Storage Adapter

Local PC
└── apps/m2k-bridge
    ├── FastAPI
    ├── libm2k / libiio
    ├── ADALM2000 Control
    ├── Waveform Acquisition
    ├── Feature Extraction
    └── localhost WebSocket
```

### 3.2 数据流

```text
KiCad Zip
→ Object Storage
→ Worker 解压
→ KiCad CLI 导出 ERC/DRC/Netlist/SVG/STEP
→ Parser 结构化
→ PostgreSQL 保存 Design Graph
→ AI 生成设计摘要和风险

ADALM2000
→ 本地 M2K Bridge
→ 浏览器 localhost WS
→ 前端显示波形
→ 用户保存 Capture
→ 上传测量摘要到 API
→ AI 分析设计上下文 + 测量数据

PCB 照片
→ Object Storage
→ AI 视觉分析
→ 用户标注
→ 关联 Component / Net / Debug Step
```

---

## 4. 技术栈

### 4.1 Monorepo

使用 pnpm、Turborepo、TypeScript、ESLint、Prettier、Zod、Prisma。

### 4.2 前端

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Zustand
- TanStack Query
- React Hook Form
- Zod
- uPlot 或 Canvas 绘制波形
- Monaco Editor，用于代码生成预览
- React Flow，用于 Debug Plan / Design Graph 可视化
- Konva 或 Fabric.js，用于 PCB 照片标注

### 4.3 后端

- NestJS 或 Fastify
- Prisma
- PostgreSQL
- pgvector
- Redis
- BullMQ
- S3-compatible object storage
- OpenAPI

### 4.4 Worker

- Node.js Worker
- KiCad CLI Docker 镜像
- Python 脚本可选
- STEP 转 glTF 可后置

### 4.5 本地 Bridge

- Python 3.11+
- FastAPI
- websockets
- pydantic
- numpy
- scipy
- libm2k / libiio
- PyInstaller 打包

### 4.6 AI

- 模型适配器层：Claude、DeepSeek、OpenAI-compatible
- RAG：pgvector、hybrid search、rerank 可后置
- Vision：多模态模型接口
- Speech：浏览器 Web Speech API 或云端 STT，TTS 可后置

---

## 5. 目录结构

```text
board-debug-copilot/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── projects/
│   │   │   ├── design-viewer/
│   │   │   ├── board-photo/
│   │   │   ├── bench/
│   │   │   ├── waveform/
│   │   │   ├── debug-copilot/
│   │   │   ├── reports/
│   │   │   └── settings/
│   │   ├── lib/
│   │   └── styles/
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── projects/
│   │   │   │   ├── files/
│   │   │   │   ├── kicad/
│   │   │   │   ├── components/
│   │   │   │   ├── captures/
│   │   │   │   ├── ai/
│   │   │   │   ├── reports/
│   │   │   │   └── bridge/
│   │   │   ├── common/
│   │   │   └── main.ts
│   ├── worker/
│   │   ├── src/
│   │   │   ├── jobs/
│   │   │   ├── processors/
│   │   │   ├── parsers/
│   │   │   └── main.ts
│   └── m2k-bridge/
│       ├── src/
│       │   ├── main.py
│       │   ├── device.py
│       │   ├── oscilloscope.py
│       │   ├── wavegen.py
│       │   ├── measurement.py
│       │   ├── websocket.py
│       │   └── security.py
├── packages/
│   ├── db/
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── src/
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── dto/
│   │   │   ├── schemas/
│   │   │   └── types/
│   ├── ai/
│   │   ├── src/
│   │   │   ├── providers/
│   │   │   ├── agents/
│   │   │   ├── prompts/
│   │   │   └── tools/
│   ├── kicad/
│   │   ├── src/
│   │   │   ├── parser/
│   │   │   ├── cli/
│   │   │   └── graph/
│   ├── instrument-protocol/
│   └── ui/
├── docker/
│   └── kicad-worker.Dockerfile
├── docs/
└── package.json
```

---

## 6. 数据库设计

Claude Code 需要在 `packages/db/prisma/schema.prisma` 中实现以下核心模型。字段可根据实际代码细化，但关系必须保留。

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ProjectStatus {
  CREATED
  UPLOADED
  PARSING
  READY
  ERROR
}

enum FileKind {
  KICAD_ZIP
  KICAD_PROJECT
  SCHEMATIC
  PCB
  BOM
  NETLIST
  ERC_REPORT
  DRC_REPORT
  PCB_PHOTO
  CAPTURE_FILE
  REPORT
  OTHER
}

enum CaptureKind {
  OSCILLOSCOPE
  FFT
  BODE
  LOGIC
  DMM
  POWER
}

enum DiagnosisSeverity {
  INFO
  WARNING
  CRITICAL
}

model User {
  id        String   @id @default(uuid())
  email     String?  @unique
  name      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  projects  Project[]
}

model Project {
  id           String        @id @default(uuid())
  userId       String?
  name         String
  description  String?
  status       ProjectStatus @default(CREATED)
  currentIssue String?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  user        User?          @relation(fields: [userId], references: [id])
  files       ProjectFile[]
  components  Component[]
  nets        Net[]
  testPoints  TestPoint[]
  photos      BoardPhoto[]
  captures    Capture[]
  debugSteps  DebugStep[]
  aiThreads   AiThread[]
  reports     DebugReport[]
}

model ProjectFile {
  id          String   @id @default(uuid())
  projectId   String
  kind        FileKind
  filename    String
  objectKey   String
  mimeType    String?
  sizeBytes   Int?
  checksum    String?
  parseStatus String?
  parseLog    String?
  createdAt   DateTime @default(now())

  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model Component {
  id            String   @id @default(uuid())
  projectId     String
  ref           String
  value         String?
  symbol        String?
  footprint     String?
  partNumber    String?
  manufacturer  String?
  datasheetUrl  String?
  x             Float?
  y             Float?
  rotation      Float?
  side          String?
  rawJson       Json?

  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  pins          Pin[]
  bomMatches    PartMatch[]
  testPoints    TestPoint[]
}

model Pin {
  id          String   @id @default(uuid())
  componentId String
  number      String
  name        String?
  type        String?
  netId       String?

  component   Component @relation(fields: [componentId], references: [id], onDelete: Cascade)
  net         Net?      @relation(fields: [netId], references: [id])
}

model Net {
  id                String   @id @default(uuid())
  projectId          String
  name              String
  netClass           String?
  inferredRole       String?
  expectedVoltage    String?
  expectedFrequency  String?
  rawJson            Json?

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  pins        Pin[]
  testPoints  TestPoint[]
  captures    Capture[]
}

model TestPoint {
  id          String   @id @default(uuid())
  projectId   String
  componentId String?
  netId       String?
  label       String
  description String?
  x           Float?
  y           Float?
  source      String
  createdAt   DateTime @default(now())

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  component   Component? @relation(fields: [componentId], references: [id])
  net         Net? @relation(fields: [netId], references: [id])
}

model PartMatch {
  id                String   @id @default(uuid())
  componentId        String
  source            String
  externalPartId     String?
  matchedPartNumber  String?
  confidence         Float?
  summaryJson        Json?

  component Component @relation(fields: [componentId], references: [id], onDelete: Cascade)
}

model RuleViolation {
  id             String   @id @default(uuid())
  projectId       String
  type           String
  source         String
  severity       DiagnosisSeverity
  title          String
  message        String
  evidence       Json?
  recommendation String?
  createdAt      DateTime @default(now())
}

model BoardPhoto {
  id          String   @id @default(uuid())
  projectId   String
  objectKey   String
  filename    String
  side        String?
  width       Int?
  height      Int?
  createdAt   DateTime @default(now())

  project     Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  annotations PhotoAnnotation[]
}

model PhotoAnnotation {
  id                String   @id @default(uuid())
  photoId            String
  label              String
  type               String
  bbox               Json?
  polygon            Json?
  linkedComponentId  String?
  linkedNetId        String?
  note               String?
  aiGenerated        Boolean @default(false)
  createdAt          DateTime @default(now())

  photo BoardPhoto @relation(fields: [photoId], references: [id], onDelete: Cascade)
}

model Capture {
  id          String   @id @default(uuid())
  projectId   String
  netId       String?
  kind        CaptureKind
  title       String?
  objectKey   String?
  sampleRate  Float?
  sampleCount Int?
  durationMs  Float?
  instrument  String
  configJson  Json?
  summaryJson Json?
  createdAt   DateTime @default(now())

  project      Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  net          Net? @relation(fields: [netId], references: [id])
  measurements Measurement[]
  diagnoses    AiDiagnosis[]
}

model Measurement {
  id        String   @id @default(uuid())
  captureId String
  channel   String
  key       String
  value     Float
  unit      String?
  createdAt DateTime @default(now())

  capture Capture @relation(fields: [captureId], references: [id], onDelete: Cascade)
}

model DebugStep {
  id                String   @id @default(uuid())
  projectId          String
  title             String
  description        String?
  targetNetId        String?
  targetComponentId  String?
  instrumentPreset   Json?
  expectedResult     Json?
  status             String @default("TODO")
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model AiThread {
  id        String   @id @default(uuid())
  projectId String
  title     String?
  createdAt DateTime @default(now())

  project  Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  messages AiMessage[]
}

model AiMessage {
  id        String   @id @default(uuid())
  threadId  String
  role      String
  content   String
  metadata  Json?
  createdAt DateTime @default(now())

  thread AiThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
}

model AiDiagnosis {
  id         String   @id @default(uuid())
  projectId  String
  captureId  String?
  severity   DiagnosisSeverity
  title      String
  summary    String
  evidence   Json?
  causes     Json?
  actions    Json?
  confidence Float?
  createdAt  DateTime @default(now())

  capture Capture? @relation(fields: [captureId], references: [id])
}

model DebugReport {
  id        String   @id @default(uuid())
  projectId String
  title     String
  status    String
  contentMd String?
  objectKey String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
}
```

---

## 7. API Contract

### 7.1 Projects

```http
POST /api/v1/projects
GET  /api/v1/projects
GET  /api/v1/projects/:projectId
PATCH /api/v1/projects/:projectId
DELETE /api/v1/projects/:projectId
```

创建项目：

```json
{
  "name": "Sensor Board Debug",
  "description": "调试 I2C 传感器板输出异常",
  "currentIssue": "板子上电后无 I2C ACK"
}
```

### 7.2 File Upload

```http
POST /api/v1/projects/:projectId/files/presign
POST /api/v1/projects/:projectId/files/complete
GET  /api/v1/projects/:projectId/files
```

### 7.3 KiCad Parsing

```http
POST /api/v1/projects/:projectId/kicad/parse
GET  /api/v1/projects/:projectId/kicad/status
GET  /api/v1/projects/:projectId/components
GET  /api/v1/projects/:projectId/nets
GET  /api/v1/projects/:projectId/test-points
GET  /api/v1/projects/:projectId/violations
```

### 7.4 Board Photos

```http
POST /api/v1/projects/:projectId/photos
GET  /api/v1/projects/:projectId/photos
POST /api/v1/photos/:photoId/annotations
GET  /api/v1/photos/:photoId/annotations
POST /api/v1/photos/:photoId/analyze
```

### 7.5 Captures

```http
POST /api/v1/projects/:projectId/captures
GET  /api/v1/projects/:projectId/captures
GET  /api/v1/captures/:captureId
POST /api/v1/captures/:captureId/measurements
POST /api/v1/captures/:captureId/analyze
```

保存 capture summary：

```json
{
  "kind": "OSCILLOSCOPE",
  "title": "VIN/VOUT 1kHz response",
  "netId": "net_vout",
  "instrument": "ADALM2000",
  "sampleRate": 1000000,
  "sampleCount": 10000,
  "configJson": {
    "ch1": "VIN",
    "ch2": "VOUT",
    "timeBase": "500us/div"
  },
  "summaryJson": {
    "ch1": { "vpp": 2.0, "frequencyHz": 1000 },
    "ch2": { "vpp": 19.5, "frequencyHz": 1000, "phaseDeg": 178 }
  }
}
```

### 7.6 AI

```http
POST /api/v1/projects/:projectId/ai/chat
POST /api/v1/projects/:projectId/ai/review-schematic
POST /api/v1/projects/:projectId/ai/review-pcb
POST /api/v1/projects/:projectId/ai/generate-debug-plan
POST /api/v1/captures/:captureId/ai/analyze
POST /api/v1/photos/:photoId/ai/analyze
```

AI chat request：

```json
{
  "threadId": "thread_001",
  "message": "U3 的输出为什么有削顶？下一步应该怎么测？",
  "context": {
    "selectedComponentId": "cmp_u3",
    "selectedNetId": "net_vout",
    "activeCaptureId": "cap_001"
  }
}
```

AI response：

```json
{
  "answer": "根据当前测量，VOUT 上峰接近供电轨，结合 U3 供电和输出摆幅参数，较可能是运放输出摆幅不足。",
  "evidence": [
    "CH2 Vpp=19.5V",
    "phase=178°",
    "U3 powered by ±12V",
    "gain target ≈ -10"
  ],
  "actions": [
    {
      "title": "降低输入幅度重新测量",
      "instrumentPreset": {
        "wavegen": { "w1": { "type": "sine", "frequency": 1000, "amplitudeVpp": 0.3 } },
        "scope": { "ch1": "VIN", "ch2": "VOUT", "timeBase": "500us/div" }
      }
    }
  ]
}
```

### 7.7 Reports

```http
POST /api/v1/projects/:projectId/reports
GET  /api/v1/projects/:projectId/reports
GET  /api/v1/reports/:reportId
POST /api/v1/reports/:reportId/generate
```

---

## 8. M2K Bridge API

Bridge 默认监听：

```text
http://127.0.0.1:3777
ws://127.0.0.1:3777/ws
```

### 8.1 Security

必须实现：

- Pairing code；
- allowed origin；
- token；
- emergency stop；
- output enable confirmation。

### 8.2 REST

```http
GET  /v1/status
GET  /v1/devices
POST /v1/devices/connect
POST /v1/devices/disconnect
POST /v1/emergency-stop

POST /v1/wavegen/config
POST /v1/wavegen/enable
POST /v1/wavegen/disable

POST /v1/scope/config
POST /v1/scope/start
POST /v1/scope/stop
GET  /v1/scope/measurements
POST /v1/scope/snapshot

POST /v1/logic/config
POST /v1/logic/start
POST /v1/logic/stop
```

### 8.3 WebSocket Events

```json
{
  "type": "scope.frame",
  "sequence": 123,
  "timestamp": 1720000000,
  "payload": {
    "sampleRate": 1000000,
    "channels": ["CH1", "CH2"],
    "displayData": {
      "CH1": [0.1, 0.2, 0.3],
      "CH2": [1.0, 2.0, 3.0]
    }
  }
}
```

```json
{
  "type": "measurements.update",
  "payload": {
    "CH1": { "vpp": 2.0, "frequencyHz": 1000, "offset": 0.01 },
    "CH2": { "vpp": 19.6, "frequencyHz": 1000, "phaseDeg": 178 }
  }
}
```

---

## 9. AI Agent 设计

### 9.1 Agent Router

根据用户问题分类：

```ts
type AgentIntent =
  | 'PROJECT_SUMMARY'
  | 'SCHEMATIC_REVIEW'
  | 'PCB_REVIEW'
  | 'PART_SELECTION'
  | 'PHOTO_INSPECTION'
  | 'INSTRUMENT_PLANNING'
  | 'MEASUREMENT_ANALYSIS'
  | 'PROTOCOL_DEBUG'
  | 'REPORT_GENERATION'
  | 'GENERAL_CHAT'
```

### 9.2 Agent Tools

Claude Code 需要实现工具接口，但可先 mock。

```ts
interface AgentToolContext {
  projectId: string
  userId?: string
}

interface AgentTool<TInput, TOutput> {
  name: string
  description: string
  run(input: TInput, ctx: AgentToolContext): Promise<TOutput>
}
```

首批工具：

```text
getProjectSummary
getComponents
getComponentByRef
getNets
getNetByName
getErcViolations
getDrcViolations
searchPartsDatabase
getCaptureSummary
getRecentCaptures
getPhotoAnnotations
generateInstrumentPreset
createDebugStep
createReportDraft
```

### 9.3 输出约束

所有诊断类输出必须包含：

```ts
interface StructuredDiagnosis {
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  title: string
  summary: string
  evidence: string[]
  possibleCauses: string[]
  recommendedActions: Array<{
    title: string
    description: string
    instrumentPreset?: unknown
    targetNet?: string
    targetComponent?: string
  }>
  confidence: number
}
```

---

## 10. UI 页面详细要求

### 10.1 项目首页 `/projects/:id`

布局：

- 顶部：项目名、状态、上传按钮、连接状态、生成报告；
- 左侧：工程树；
- 中间：概览卡片；
- 右侧：Copilot；
- 底部：最近测量和调试记录。

卡片：

- 工程解析状态；
- 原理图风险；
- PCB 风险；
- BOM 风险；
- 当前调试计划；
- 最近波形；
- 最近照片。

### 10.2 Design View `/projects/:id/design`

Tabs：

- Schematic；
- PCB；
- BOM；
- Nets；
- ERC/DRC；
- 3D。

交互：

- 点击组件；
- 点击网络；
- 跳转测试点；
- 询问 AI；
- 生成调试建议。

### 10.3 Bench View `/projects/:id/bench`

区域：

- ADALM2000 连接状态；
- 信号源控制；
- 示波器 CH1/CH2；
- 波形图；
- FFT；
- 当前测试点；
- 接线说明；
- AI 分析。

### 10.4 Photo View `/projects/:id/photos`

区域：

- 照片列表；
- 大图查看；
- 标注工具；
- AI 视觉分析；
- 与组件/网络关联；
- 上传局部特写。

### 10.5 Debug Plan `/projects/:id/debug-plan`

区域：

- 调试树；
- 待执行步骤；
- 已执行步骤；
- 每一步对应接线、ADALM2000 设置、预期结果、实测结果、AI 结论。

### 10.6 Copilot Panel

所有页面右侧都有 Copilot。

支持快捷问题：

- “这个板子的主要风险是什么？”
- “下一步我该测哪里？”
- “当前波形正常吗？”
- “这个器件选型是否合理？”
- “根据这张照片，焊接有没有问题？”
- “生成调试报告。”

---

## 11. KiCad Worker 实现要求

### 11.1 输入

```json
{
  "projectId": "xxx",
  "zipObjectKey": "uploads/project.zip"
}
```

### 11.2 处理步骤

1. 下载 zip；
2. 创建临时目录；
3. 解压；
4. 查找 `.kicad_pro`；
5. 查找 `.kicad_sch`；
6. 查找 `.kicad_pcb`；
7. 调用 KiCad CLI：
   - `kicad-cli sch erc`
   - `kicad-cli sch export netlist`
   - `kicad-cli sch export svg`
   - `kicad-cli pcb drc`
   - `kicad-cli pcb export svg`
   - `kicad-cli pcb export step`
8. 上传导出文件；
9. 解析报告；
10. 写入数据库；
11. 更新 project 状态。

### 11.3 失败处理

- 缺少 KiCad 文件；
- CLI 不存在；
- CLI 版本不兼容；
- 工程依赖库缺失；
- ERC/DRC 产生警告但不应视为解析失败；
- 真正失败写入 parseLog。

---

## 12. 元器件数据库 Adapter

MVP 可先写 mock，后续接入真实 100 万器件库。

接口：

```ts
interface PartsDatabaseAdapter {
  matchBomItem(input: {
    ref: string
    value?: string
    footprint?: string
    partNumber?: string
  }): Promise<PartMatchResult[]>

  lookupPart(partNumber: string): Promise<PartDetail | null>

  checkPartRisk(input: {
    partNumber?: string
    componentContext: unknown
    circuitContext: unknown
  }): Promise<PartRisk[]>
}
```

Mock 行为：

- 根据 ref/value 给出基础解释；
- 运放、电阻、电容、LDO、MCU、连接器等给出常见规则风险；
- 不要假装有真实库存和价格。

---

## 13. 规则引擎

MVP 先实现硬编码规则。

### 13.1 原理图规则

- 电源网络是否存在；
- GND 是否存在；
- 单引脚网络；
- 未连接输入；
- 运放反馈是否可疑；
- 开漏总线缺上拉；
- MCU 电源脚附近缺少去耦；
- LDO 输入/输出电容缺失；
- 复位脚悬空；
- 连接器关键脚未保护。

### 13.2 测量规则

- clipping；
- offset 异常；
- 频率不符；
- 增益不符；
- 相位不符；
- 噪声过大；
- 振铃；
- 输入悬空；
- 输出无响应；
- 逻辑高低电平不合理。

输出统一成 RuleViolation / AiDiagnosis。

---

## 14. 语音交互

MVP 简化：

- 浏览器端录音或 Web Speech API；
- 转写成文本；
- 发送到 AI chat；
- 返回文字；
- 可选 TTS 播放。

前端实现：

```text
Push-to-talk button
→ speech-to-text
→ ai/chat
→ streaming answer
→ optional speech synthesis
```

---

## 15. 报告生成

报告为 Markdown 优先，后续导出 PDF。

内容：

1. 项目摘要；
2. 上传工程信息；
3. 设计审查问题；
4. BOM 风险；
5. PCB/DRC/DFM 风险；
6. PCB 照片标注；
7. 调试步骤；
8. ADALM2000 设置；
9. 测量数据；
10. 波形截图；
11. AI 诊断；
12. 结论和下一步修改建议。

---

## 16. 实施阶段

### Phase 0：项目初始化

任务：

- 创建 monorepo；
- 配置 pnpm/turbo；
- 创建 Next.js；
- 创建 API；
- 创建 Prisma；
- 创建 PostgreSQL；
- 创建基础 UI；
- 创建 mock data。

验收：

- `pnpm dev` 可启动 web/api；
- Prisma migrate 成功；
- 首页可访问。

### Phase 1：项目上传与 KiCad 解析

任务：

- Project CRUD；
- File upload；
- Worker job；
- KiCad zip 解压；
- mock parse；
- 后续接 KiCad CLI；
- 显示组件、网络、ERC/DRC。

验收：

- 上传工程后 project 进入 READY；
- 页面显示 components/nets/violations。

### Phase 2：Design View 和 AI 审查

任务：

- Design View UI；
- 组件列表；
- 网络列表；
- 规则引擎；
- AI review；
- Copilot panel。

验收：

- 用户可问某个组件/网络；
- AI 输出结构化诊断。

### Phase 3：M2K Bridge 和 Bench

任务：

- Bridge FastAPI；
- mock device；
- 前端连接 localhost；
- 信号源控制；
- 示波器 mock waveform；
- 测量摘要；
- 保存 capture；
- AI 分析 capture。

验收：

- 无真实 ADALM2000 也可 mock 演示；
- 有设备时可切换真实模式。

### Phase 4：PCB 照片和视觉诊断

任务：

- Photo upload；
- 标注工具；
- AI image analysis；
- 关联 component/net；
- 生成 photo diagnosis。

验收：

- 上传图片，标注区域，AI 能围绕标注回答。

### Phase 5：Debug Plan 与报告

任务：

- AI generate debug plan；
- DebugStep CRUD；
- 每步关联 capture；
- Report generation；
- Markdown preview。

验收：

- 可以生成一个完整调试报告。

---

## 17. 开发命令

Claude Code 需要生成以下脚本：

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "db:generate": "pnpm --filter @app/db prisma generate",
    "db:migrate": "pnpm --filter @app/db prisma migrate dev",
    "db:studio": "pnpm --filter @app/db prisma studio"
  }
}
```

---

## 18. 环境变量

```env
DATABASE_URL=
REDIS_URL=

S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

LLM_PROVIDER=
LLM_API_KEY=
LLM_CHAT_MODEL=
EMBEDDING_PROVIDER=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=

NEXT_PUBLIC_API_BASE_URL=
NEXT_PUBLIC_BRIDGE_URL=http://127.0.0.1:3777

BRIDGE_ALLOWED_ORIGINS=
BRIDGE_PAIRING_SECRET=
```

---

## 19. Claude Code 实施要求

请 Claude Code 按以下原则实现：

1. 优先做可运行骨架，不要一次性实现全部复杂功能；
2. 所有外部依赖都必须抽象 adapter；
3. AI、KiCad、ADALM2000、元件库都必须支持 mock 模式；
4. 前端页面必须先能用 mock 数据演示完整流程；
5. 数据模型和 API 要稳定；
6. 不要把高频波形大数组直接存 PostgreSQL；
7. 不要让云端直接控制 USB 设备；
8. Bridge 必须只监听 localhost；
9. AI 输出必须结构化；
10. 所有危险仪器操作必须用户确认；
11. 所有上传文件必须经过大小和类型校验；
12. 报告先用 Markdown，不急于 PDF；
13. KiCad CLI 失败不能让整个项目崩溃；
14. 设计页面要为后续 3D、照片配准和多仪器扩展留接口。

---

## 20. 第一轮 Claude Code 任务拆分

### Task 1：初始化 Monorepo

实现：

- pnpm workspace；
- Turborepo；
- apps/web；
- apps/api；
- packages/db；
- packages/contracts；
- packages/ai；
- 基础 README；
- env example。

### Task 2：数据库和 Prisma

实现：

- schema.prisma；
- migrate；
- seed mock project；
- Prisma service；
- API health check。

### Task 3：Project CRUD + Upload Mock

实现：

- Project API；
- File API；
- mock object storage；
- Project list 页面；
- Project detail 页面。

### Task 4：KiCad Mock Parser

实现：

- Worker job；
- mock components/nets/violations；
- Design View 页面；
- component/net detail panel。

### Task 5：AI Copilot Mock

实现：

- ai/chat API；
- agent router；
- mock tools；
- streaming answer；
- right-side copilot panel。

### Task 6：M2K Bridge Mock

实现：

- Python FastAPI bridge；
- `/status`；
- `/devices`；
- `/scope/start`；
- mock waveform websocket；
- web 端 bench page 连接 bridge。

### Task 7：Capture + Measurement

实现：

- capture API；
- measurement API；
- bench waveform；
- save capture；
- analyze capture mock AI。

### Task 8：Photo Upload + Annotation

实现：

- photo API；
- photo page；
- canvas annotation；
- photo AI mock。

### Task 9：Debug Plan

实现：

- debug step model/API；
- AI generate debug plan；
- UI timeline/tree；
- step status update。

### Task 10：Report

实现：

- report model/API；
- markdown generator；
- preview page；
- download `.md`。

---

## 21. 首个 Demo 数据

内置一个 mock 项目：

名称：Inverting Amplifier Debug Demo

包含：

- U1：运放；
- Rin：10 kΩ；
- Rf：100 kΩ；
- Vin；
- Vout；
- GND；
- 电源 ±12 V；
- 目标增益：-10；
- 测量：
  - CH1 Vin = 2.0 Vpp, 1 kHz；
  - CH2 Vout = 19.6 Vpp, 1 kHz；
  - phase = 178°；
- AI 诊断：
  - 若输出削顶，可能输入过大或运放输出摆幅不足；
  - 建议降低 W1 幅值并复测；
  - 建议检查供电和反馈电阻。

这个 Demo 必须能在无 ADALM2000、无 KiCad CLI、无真实元器件库时完整跑通。

---

## 22. 最终验收标准

项目达到以下状态即可视为原型完成：

- 可创建项目；
- 可上传或加载 KiCad Demo；
- 可显示原理图/PCB/BOM/Net；
- 可显示设计风险；
- 可与 Copilot 对话；
- 可连接 mock M2K Bridge；
- 可显示波形；
- 可保存 capture；
- 可上传 PCB 照片并标注；
- 可生成 debug plan；
- 可生成 Markdown report；
- 所有模块都有 adapter/mock；
- 可以部署到 Vercel + Railway；
- README 写清楚本地运行和部署步骤。

---

## 23. 后续扩展方向

原型完成后，再扩展：

- 真实 KiCad CLI 解析；
- 真实 ADALM2000 libm2k；
- 真实元器件数据库；
- 真实多模态 PCB 照片识别；
- 自动照片-PCB 配准；
- 逻辑分析和协议解码；
- Network Analyzer/Bode；
- STEP/3D 查看；
- 多人协作；
- 组织和权限；
- 与 ezPLM/Tindie/元器件库打通。

---

# 结论

本项目的核心不是“做一个聊天机器人”，而是建立一个工程调试上下文系统：

> **Design Context + Part Knowledge + Measurement Context + Visual Context + AI Reasoning**

Claude Code 第一阶段应优先实现完整的可运行闭环，所有复杂能力都通过 adapter 和 mock 保留扩展口。只要第一版把 KiCad 工程、ADALM2000 测量、PCB 照片和 AI 调试建议串起来，就已经具备准 LabSight 原型的核心价值。
