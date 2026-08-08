# M2K Bridge

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
