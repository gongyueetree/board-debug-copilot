# M2K Bridge

本地 ADALM2000 网关。**只监听 127.0.0.1:3777**，云端不直接控制 USB（CLAUDE.md 硬性原则 #5）。

不进 turbo pipeline，单独启动。

## 运行

```bash
cd apps/m2k-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
BRIDGE_MOCK=true uvicorn src.main:app --host 127.0.0.1 --port 3777 --reload
```

或在仓库根目录：

```bash
pnpm bridge:dev
```

## 端点

| 端点 | 状态 | 说明 |
| --- | --- | --- |
| `GET /status` | P0 ✅ | 设备状态，顶栏联动 |
| `GET /devices` | P0 ✅ | 设备枚举 |
| `POST /debug/scenario` | P0 ✅ | 切换 mock 故障场景 |
| `POST /awg` | P4 | 信号源配置，危险值需 confirm |
| `POST /scope` | P4 | 示波器配置 |
| `WS /ws` | P4 | 波形帧 + 测量帧推送 |

## Mock 场景

数值规格见 `docs/05-agent-design.md` §11.1：
`normal` / `gain_error`（默认）/ `clipping` / `noisy` / `no_response`。

噪声必须用固定随机种子，保证演示与评测可复现。

## 无 ADALM2000 硬件

`BRIDGE_MOCK=true` 时用 numpy 合成波形，全链路无需硬件。
接真实设备需另装 `libm2k` / `libiio`（P4 之后）。
