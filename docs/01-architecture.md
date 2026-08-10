# 01 系统架构

## 部署拓扑
```
Vercel（或 Railway，见 docs/04 决策）
└── apps/web (Next.js)
    项目总览 / 设计审查 / 调试工作台 / PCB照片 / 调试计划 / 测试报告

Railway
├── apps/api (NestJS)
│   REST + SSE 流式 AI 回复 + AI Orchestrator + Project/KiCad/Capture/Report Service
├── apps/worker (BullMQ)
│   KiCad zip 解析（mock→CLI）/ ERC-DRC 解析 / BOM 匹配 / 报告生成
├── PostgreSQL + pgvector
├── Redis
└── Object Storage（S3 兼容，MVP 用 mock 本地盘 adapter）

本地 PC
└── apps/m2k-bridge (FastAPI, 127.0.0.1:3777)
    /status /devices /awg/config /scope/start，WS 波形流
    MOCK_MODE=true 时用 numpy 生成合成波形
```

## 三条数据流
1. **设计流**：zip 上传 → 对象存储 → worker 解压 → (mock/CLI) 解析 → Component/Net/Pin/ERC/DRC 入库 → AI 设计摘要与风险
2. **测量流**：浏览器 ⇄ localhost Bridge WS → 前端实时波形 + FFT → 用户保存 Capture → 测量摘要（JSON，非原始数组）POST 到 api → AI 分析
3. **视觉流**：照片上传 → 对象存储 → AI 多模态分析（mock 先行）→ 用户 Konva 标注 → 标注关联 Component/Net/DebugStep

## 异步任务（apps/worker）
```
单队列 bdc-jobs，按 job name 分派
├── kicad.parse       worker 直接做：解压 + kicad-cli 是文件系统重活
├── report.generate   回调 api：纯 DB 聚合，保持单一实现
├── ai.long-task      回调 api
└── parts.match-bom   回调 api
```
- payload schema 在 packages/contracts，入队与出队两侧都校验（队列是进程边界）
- 无 REDIS_URL：worker 空转，api 同步兜底并在响应标 degraded
- 失败一律写回 ProjectFile.parseStatus / parseLog，不静默

## 对象存储（packages/storage）
- api 与 worker 共用同一 adapter，避免 S3 配置与 key 规范分成两份漂移
- mock（本地盘，无盘退内存）/ s3（R2、AWS S3、MinIO）
- 大文件走 presign 直传，不经过 Node 进程
- 用户文件名 sanitize 后加 uuid 前缀，不直接拼进 objectKey

## AI Agent 架构（packages/ai）
```
AgentRouter（意图分类）
├── design_review    工具: getComponents, getNets, getErcDrc, ruleEngine
├── measure_guide    工具: getNets, getTestPoints, buildM2kSetup
├── waveform_analyze 工具: getCapture, measurementRules
├── fault_diagnose   工具: 全部上下文 + 概率排序
├── photo_analyze    工具: vision adapter + getAnnotations
└── report_generate  工具: 汇总所有表 → Markdown
```
- Provider 接口：`chat(messages, opts) / chatStream / vision(images, prompt)`，实现 ClaudeProvider / DeepSeekProvider / MockProvider
- 所有 Agent 输出经 Zod schema 校验（contracts 包定义 `AiDiagnosisSchema`、`DebugPlanSchema`、`DesignReviewSchema` 等），校验失败自动重试一次后降级为 error 结构

## 规则引擎（先于 LLM，硬编码）
- 原理图规则：电源/GND 存在、单引脚网络、悬空输入、运放反馈、开漏缺上拉、去耦不足、LDO 电容、复位悬空、连接器保护
- 测量规则：clipping、offset 异常、频率/增益/相位不符、噪声、振铃、悬空、无响应、逻辑电平异常
- 输出统一 `RuleViolation`，与 AI 结果同结构合并展示

## API 面（核心端点）
```
POST /projects                 GET /projects/:id
POST /projects/:id/files       (zip / photo，校验类型大小)
GET  /projects/:id/design      (components+nets+violations 聚合)
POST /projects/:id/captures    GET /projects/:id/captures
POST /ai/chat                  (SSE 流式，body 含 projectId + mode)
POST /ai/design-review         POST /ai/debug-plan
POST /ai/analyze-capture       POST /ai/analyze-photo
POST /projects/:id/debug-steps CRUD
POST /projects/:id/reports     GET /reports/:id (markdown)
```

## Bridge 安全分层
```
Origin 校验      挡住浏览器跨站
配对 token       挡住本机非浏览器调用（Origin 头可以不带）
二次确认 428     幅度 > 5Vpp 或偏置 ≠ 0
硬件上限 422     超 ADALM2000 能力，confirm 也救不了
急停             不需要 token —— 因 token 过期而失效的急停比没有更糟
```

## Bridge 协议（instrument-protocol 包共享类型）
```
WS 消息: {type:"waveform", ch1:[...], ch2:[...], meta:{fs,ts}}
         {type:"measurements", vpp,vrms,freq,gain,phase,offset,thdn}
REST:    GET /status → {connected, device, serial, firmware, mock}
         POST /awg   → {wave,freq,amp,offset,channel} (危险值需 confirm 字段)
         POST /scope → {timebase,sampleRate,trigger,coupling}
```
