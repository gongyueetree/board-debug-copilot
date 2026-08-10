# 07 运维手册

覆盖 mock 与真实能力的边界、异步任务、对象存储、KiCad 解析、Bridge 配对与部署。
架构见 `docs/01`，部署基础见 `docs/04`，智能体见 `docs/05`。

---

## 1. mock / real 边界

这是本项目最重要的一张表。**任何一列为 mock 都不影响其余部分工作**，
`MOCK_MODE=true` 时全链路无外部依赖可完整演示。

| 能力 | mock（默认） | real | 切换 | 真实路径验证状态 |
| --- | --- | --- | --- | --- |
| LLM | 预置结果，确定性 | Gemini / Claude / DeepSeek | `LLM_PROVIDER` + 对应 key | ✅ Gemini 已跑通评测 11/11 |
| 对象存储 | 本地盘，无盘退内存 | S3 / R2 / MinIO | `STORAGE_ADAPTER=s3` | ✅ MinIO 在 CI 每次跑通；R2/AWS 未验证，见 docs/09 |
| KiCad 解析 | 只解析包内 netlist | kicad-cli 全流程 | 装 KiCad 9 并让 `kicad-cli` 在 PATH | ⚠️ CLI 分支用假 CLI 覆盖；真实 KiCad 见 docs/08 |
| ADALM2000 | numpy 合成波形 | libm2k | `BRIDGE_MOCK=false` | ❌ **实验性，未接真实硬件验证**（见 §5） |
| 元器件库 | 内置常识参数 | ezPLM 系统库 API | `PARTS_PROVIDER=remote` | ⬜ **NOT RUN** — 签名与 provider 已验（假服务端），真实接口无 API Key，见 docs/11 |
| 队列 | 无 Redis 时同步兜底 | BullMQ | 配 `REDIS_URL` | ✅ 两条路径都验证过 |

降级从不静默：`GET /health` 会报出 `llm.degraded` 与 `storage.degraded`，
Bridge 的 `/status` 会报 `adapter`、`detail`、`hardwareVerified` 与 `allowUnpairedDebug`。

**一个例外不是降级而是硬拒绝**：`NODE_ENV=production` + mock 存储 +
没有 `ALLOW_MOCK_STORAGE_IN_PRODUCTION=true` → api 与 worker 直接拒绝启动。
理由与配法见 `docs/09-storage-validation.md` §5。

---

## 2. 异步任务

单队列 `bdc-jobs`，按 job name 分派。

| 任务 | 触发 | 执行位置 |
| --- | --- | --- |
| `kicad.parse` | 上传 zip | worker 直接做（解压 + CLI 是文件系统重活） |
| `report.generate` | 生成报告 | worker 回调 api（纯 DB 聚合，保持单一实现） |
| `ai.long-task` | 批量重审 | worker 回调 api |
| `parts.match-bom` | BOM 匹配 | worker 回调 api |

```bash
# 启动 worker
pnpm --filter @app/worker dev

# 手动入队；没有 REDIS_URL 时直接本地跑 processor
pnpm job kicad.parse '{"projectId":"...","objectKey":"...","fileId":"..."}'
```

**无 `REDIS_URL` 时**：worker 空转不退出，api 改为同步执行解析并在响应里
标 `degraded: true`。本地开发不必起 Redis。

失败一律落库：`ProjectFile.parseStatus` + `parseLog`，不会只留一个卡在
PARSING 的项目让人猜。

---

## 3. 对象存储

### 本地（默认）

不需要任何配置，文件落在 `./storage`。

### Cloudflare R2

```bash
STORAGE_ADAPTER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=board-debug-copilot
S3_ACCESS_KEY_ID=<R2 access key>
S3_SECRET_ACCESS_KEY=<R2 secret>
S3_FORCE_PATH_STYLE=true
```

### AWS S3

```bash
STORAGE_ADAPTER=s3
S3_ENDPOINT=            # 留空用默认端点
S3_REGION=ap-northeast-1
S3_BUCKET=...
S3_FORCE_PATH_STYLE=false
```

### MinIO（自建）

```bash
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
```

### 直传

大文件不走 api 进程：

```
POST /api/v1/projects/:id/kicad/presign   → { url, objectKey, method, isFallback }
PUT  <url>                                 → 浏览器直传对象存储
POST /api/v1/projects/:id/kicad/complete   → 登记 ProjectFile 并入队解析
```

mock 存储没有直传能力，`isFallback: true`，前端回落到 base64 上传。
**base64 上传是开发与 mock 的兜底，不是大文件的长期方案** —— 整个文件会在
Node 进程内存里过一遍。

### 限制

| 类型 | 上限 | 允许 MIME |
| --- | --- | --- |
| zip | 100 MB | application/zip |
| 照片 | 20 MB | jpeg / png / webp |
| 波形 | 50 MB | json |
| 报告 | 20 MB | markdown / pdf / doc |

用户文件名不会直接拼进 objectKey：先 sanitize 再加 uuid 前缀。

---

## 4. KiCad 解析

```
上传 → ProjectFile(PENDING) → Project(PARSING) → 入队
     → worker: 安全解压 → 定位工程 → kicad-cli → 产物入存储
     → netlist → Component/Net/Pin
     → ERC/DRC → RuleViolation(origin=ERC|DRC)
     → 规则引擎 → RuleViolation(origin=RULE_ENGINE)
     → Project(READY, designVersion+1)
```

### 需要 kicad-cli 的部分

装了 KiCad 9 且 `kicad-cli` 在 PATH（或设 `KICAD_CLI`）才有：
ERC/DRC 报告、原理图 SVG、PCB SVG。

没装也能用：包内自带 `.net` 时仍可解析出组件与网络，parseLog 明确写
「未找到 kicad-cli」，前端把它翻成可行动的说明。

### 安全

解压不用系统 `unzip`。逐条目校验：路径穿越、绝对路径、符号链接、
路径深度、条目数、解压总大小。已用构造的恶意 zip 验证五类攻击全部拦截。

### 设计版本

每次成功解析 `Project.designVersion + 1`。照片、捕获、调试步骤、报告
一律保留 —— 它们是调试过程的记录，换设计版本不代表这些工作没发生过。

---

## 5. Bridge

### 启动

```bash
pnpm bridge:dev                    # 源码
./apps/m2k-bridge/dist/bdc-bridge  # 打包产物
```

只监听 `127.0.0.1:3777`，校验 Origin。云端永远不碰 USB。

### 配对

Origin 校验挡不住本机的非浏览器调用。配对码走的是「用户能看到 Bridge
控制台」这个带外信道。

```
网页点「连接本地 Bridge」
  → POST /pairing/start，Bridge 控制台打印 6 位码（5 分钟有效）
  → 用户输入 → POST /pairing/verify → 返回 token
  → token 存 localStorage，Bridge 侧存 ~/.board-debug-copilot/bridge.json（0600）
```

需要 token：`/devices`、`/awg`、`/scope`、`WS /ws`（浏览器握手不能设 header，
token 走 query）。

不需要 token：`/status`（UI 得先知道自己未配对）、`/emergency-stop`
（急停按钮因 token 过期而失效，比没有急停更糟）。

`MOCK_MODE` 不绕过配对。`BRIDGE_REQUIRE_PAIRING=false` 仅供 CI 与内置 Demo，
`/status` 会报出它被关掉了。

`/debug/scenario` 同样要 token：它是 mock 专有，但换场景会改变波形、测量值
以及 AI 诊断结论 —— 任何能改变操作者所见的接口都是控制面。CI 与内置 Demo 用
`BRIDGE_ALLOW_UNPAIRED_DEBUG=true` 显式豁免，该开关**只**放行场景切换，
不放行 `/awg`；`/status` 会报出 `allowUnpairedDebug`。

### 真实硬件（实验性）

**`BRIDGE_MOCK=false` 尚未在真实 ADALM2000 上验证。** 接口完整、失败路径明确，
但每个标了 TODO(hardware) 的地方都需要设备在手才能确认。

这条路径不静默：`/status` 返回 `hardwareVerified=false` 与 `experimental=true`，
调试工作台据此显示「实验性硬件模式」横幅与页脚角标。

需实机验证的点：

| 项 | 现状 |
| --- | --- |
| AWG 输出频率 | 写死 75MSPS / 1024 点缓冲，实际频率并不等于请求的 `freqHz` |
| 波形类型 | 只合成 `sine` 与 `dc`；其余返回 `WAVEFORM_UNSUPPORTED`，不静默按正弦输出 |
| 采集校准 | `calibrateADC` / `calibrateDAC` 的时序与失败行为未确认 |
| 采样量纲 | `getSamples` 的通道顺序、标度、单位是假设的 |
| 设备元信息 | `getSerialNumber` / `getFirmwareVersion` 返回形状是假设的 |

把 W1/W2 接到被测板卡之前，先用独立示波器核对 Bridge 实际输出。

需要 `libm2k` + `libiio`：

- macOS：`brew install libiio`，libm2k 需从源码编译并装 Python 绑定
- Linux：Analog Devices 提供 .deb，或源码编译
- Windows：官方安装包含 Python 绑定

没装时 `/status` 返回 `LIBM2K_MISSING` 并指向本文，不崩。
装了但没插设备返回 `NO_DEVICE`，并提示 Scopy 会独占设备。

### 五个场景

`normal` / `gain_error`（默认）/ `clipping` / `noisy` / `no_response`，
数值见 `docs/05` §11.1。噪声用固定随机种子，演示可复现。
仅 `BRIDGE_MOCK=true` 时可切换。

---

## 6. Demo 与克隆

公共 Demo（`userId` 为空）**只读**。早先允许匿名写，演示方便但任何访客
都能污染所有人看到的数据。

```
未登录：6 个页面全部可读
写操作：403，提示先克隆
POST /api/v1/projects/:id/clone  → 复制到自己名下
```

克隆复制设计、调试计划、照片元数据、捕获摘要。
波形对象只引用不复制 —— 几十 MB 的原始数组不该因为点了一下克隆就复制一份。

登录：`POST /api/v1/auth/login`，邮箱即账号，无密码。生产要换成 OAuth 时
只需替换 `AuthService.login()`。

---

## 7. 生产部署注意

1. **`AUTH_SECRET` 必须配**。不配会随机生成，每次重启所有登录态失效。
2. **`BRIDGE_REQUIRE_PAIRING` 不要关**。
3. **对象存储用 s3**。Railway 容器无持久卷，mock 存储重启即丢。
4. **配 `REDIS_URL`**。否则大工程解析在请求里同步跑，会被网关超时掐断。
5. **`CORS_ORIGINS` 填实际前端域名**，不要用 `*`。
6. **pgvector 的 HNSW 索引 Prisma 表达不了**，`migrate diff` 会一直提示
   `DROP INDEX PartKnowledge_embedding_idx` —— 忽略，不要写进迁移文件。
7. **`MOCK_MODE=false` 会真实消耗模型配额**。演示环境建议保持 `true`。

---

## 8. 验收命令

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test          # 单元测试，不需要数据库
pnpm smoke         # 需要 api + web 在跑
pnpm test:agent    # 需要 api 在跑

cd apps/m2k-bridge && python -m pytest -q
```

CI 分三层：单元（快）、Bridge pytest、集成（带 Postgres 跑冒烟与评测）。
集成层固定用 mock provider —— CI 不该消耗真实配额，也不该因为外部服务
抖动变成不稳定测试。
