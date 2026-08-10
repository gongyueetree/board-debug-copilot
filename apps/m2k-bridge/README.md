# M2K Bridge

> **真实 ADALM2000 尚未验证。** 适配器接口完整、失败路径明确，
> 但标了 `TODO(hardware)` 的地方都需要设备在手才能确认。
> `BRIDGE_MOCK=true`（默认）用 numpy 合成波形，无需硬件。

本地 ADALM2000 网关。**只监听 127.0.0.1:3777**，云端不直接控制 USB（CLAUDE.md 硬性原则 #5）。

不进 turbo pipeline，单独启动。

## 给最终用户的三步

1. 下载 `bdc-bridge`（对应平台的单文件可执行程序）
2. 双击运行，看到 `Uvicorn running on http://127.0.0.1:3777` 即可
3. 打开生产站点 https://board-debug-copilot.vercel.app 的调试工作台，顶栏设备状态会变绿

**必须用 Chrome 或 Edge。** https 页面连 `ws://127.0.0.1` 依赖浏览器的 localhost 混合内容豁免，
Safari 对此更严格。

没有 ADALM2000 硬件也能跑：默认 `BRIDGE_MOCK=true` 用 numpy 合成波形，五个故障场景可切换。

## 开发者运行

```bash
cd apps/m2k-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
BRIDGE_MOCK=true uvicorn src.main:app --host 127.0.0.1 --port 3777 --reload
```

或在仓库根目录 `pnpm bridge:dev`。

## 打包

```bash
pip install pyinstaller
pyinstaller bridge.spec
# 产物在 dist/bdc-bridge
```

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /status` | 设备状态，顶栏联动 |
| `GET /devices` | 设备枚举 |
| `GET /scenarios` | 可用 mock 场景 |
| `POST /debug/scenario` | 切换 mock 故障场景 |
| `POST /awg` | 信号源配置，危险值需 `confirm` |
| `POST /awg/disable` | 关闭输出 |
| `POST /scope` | 采样率与运行状态 |
| `POST /emergency-stop` | 紧急停止 |
| `WS /ws` | 波形帧 + 测量帧，10 Hz |

## 安全设计

- **只绑 127.0.0.1**：外部网络无法访问，云端也不行
- **Origin 校验**：WebSocket 握手时检查来源，非白名单直接 4403 关闭
- **危险操作三级防护**：
  - 幅度 > 5Vpp 或偏置 ≠ 0 → 未带 `confirm` 返回 **428**，前端必须弹确认框
  - 超出 ADALM2000 硬件上限（W1 ≤10Vpp / ±5V 偏置）→ **422**，`confirm` 也救不了
  - 前端与 Bridge 用同一条判据，UI 不是唯一防线

## Mock 场景

数值规格见 `docs/05-agent-design.md` §11.1。波形由 numpy 按真实物理合成
（反相、2.5V 偏置、0.02~4.98V 轨钳位），THD+N 与主频是从该波形实测得出，
不是查表——所以 FFT 显示的和智能体推理的是同一个信号。

噪声用固定随机种子，演示与评测可复现。

| 场景 | 现象 |
| --- | --- |
| `normal` | Gain 9.94，THD+N 0.38% |
| `gain_error`（默认） | Gain 4.98，THD+N 0.40% —— R2 桥接使 Rf 等效减半 |
| `clipping` | Gain 4.95（表观），THD+N **28.2%**，贴轨 |
| `noisy` | THD+N 1.9%，噪底抬高 |
| `no_response` | CH2 ≈ 0V —— 单电源缺 Vref 偏置 |

`gain_error` 与 `clipping` 的表观增益几乎相同（4.98 vs 4.95），
唯一可靠的鉴别依据是 THD+N 与是否贴轨。这是评测用例 #11 的断言点。

## 接真实硬件

需另装 `libm2k` / `libiio`，把 `scenarios.synthesize` 换成真实采集。
接口契约（`packages/instrument-protocol`）不变。


## 架构

```
main.py          仅路由与鉴权
adapters/
  base.py        接口定义 + 硬件上限 + 确认判据
  mock_m2k.py    numpy 合成，五个场景
  real_m2k.py    libm2k，失败路径明确
protocol.py      WS 帧编码（与 packages/instrument-protocol 对应）
pairing.py       本地配对与 token 持久化
```

## 配对

Origin 校验挡不住本机的非浏览器调用。配对码走「用户能看到 Bridge 控制台」
这个带外信道 —— 对能驱动真实硬件的服务，这才是有意义的凭据。

```
GET  /pairing/status
POST /pairing/start     控制台打印 6 位码，5 分钟有效
POST /pairing/verify    {code} → {token}
POST /pairing/revoke    {token?} 不传则全部撤销
```

token 存 `~/.board-debug-copilot/bridge.json`（0600），重启不丢。

| 接口 | 需要 token | 原因 |
| --- | --- | --- |
| `/status` | ❌ | UI 得先知道自己未配对 |
| `/emergency-stop` | ❌ | 因 token 过期而失效的急停比没有更糟 |
| `/pairing/*` | ❌ | 配对本身 |
| `/devices` `/awg` `/scope` `WS /ws` | ✅ | 能驱动硬件 |

`BRIDGE_REQUIRE_PAIRING=false` 仅供 CI 与内置 Demo，`/status` 会报出它被关掉。
**MOCK_MODE 不绕过配对** —— 跳过安全步骤的演示不算演示这个产品。

## 真实硬件

需要 `libm2k` + `libiio`（不是纯 pip 包）：

| 平台 | 安装 |
| --- | --- |
| macOS | `brew install libiio`，libm2k 需源码编译并装 Python 绑定 |
| Linux | Analog Devices 提供 .deb，或源码编译 |
| Windows | 官方安装包自带 Python 绑定 |

```bash
BRIDGE_MOCK=false pnpm bridge:dev
```

失败行为：

- 没装 libm2k → `/status` 返回 `LIBM2K_MISSING` 并指向本文，不崩
- 装了但没插设备 → `NO_DEVICE`，并提示 Scopy 会独占设备
- 场景切换 → 409，真实模式没有「场景」概念

## 测试

```bash
python -m pytest -q
```

16 条用例覆盖确认、硬件上限、配对、过期、撤销、场景数值与确定性。

## 打包

```bash
pyinstaller bridge.spec     # → dist/bdc-bridge，约 17MB 单文件
```

已在 macOS arm64 上验证产物可运行。Windows / Linux 需在对应平台各打一次。
