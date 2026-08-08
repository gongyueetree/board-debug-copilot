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

## Bridge 协议（instrument-protocol 包共享类型）
```
WS 消息: {type:"waveform", ch1:[...], ch2:[...], meta:{fs,ts}}
         {type:"measurements", vpp,vrms,freq,gain,phase,offset,thdn}
REST:    GET /status → {connected, device, serial, firmware, mock}
         POST /awg   → {wave,freq,amp,offset,channel} (危险值需 confirm 字段)
         POST /scope → {timebase,sampleRate,trigger,coupling}
```
