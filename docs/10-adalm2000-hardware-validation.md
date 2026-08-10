# 10 · ADALM2000 真实硬件验证 checklist

`apps/m2k-bridge/src/adapters/real_m2k.py` 至今**没有在真实 ADALM2000 上跑过
一次**。代码结构完整、失败分支明确，但那不等于它能用。

**当前状态：NOT RUN**（2026-08-09 核对：本机没有 ADALM2000，也没装 libm2k /
libiio，见第 7 节）。

这份文档是把它从「实验性」改成「已验证」需要走完的流程。**在整份 checklist
跑完并把结果填进第 7 节之前，`hardwareVerified` 必须保持 `false`。**

> 危险提示：W1/W2 是真实输出，会驱动被测板卡。第 5 节的安全测试**先做**，
> 确认拦截生效之后，再把线接到板子上。整个流程里任何一步开始输出前，
> 先用独立示波器看一眼实际波形。

---

## 1. 环境准备

### 依赖

`libm2k` 是 `libiio` 之上的 C++ 库 + Python 绑定，**不是纯 pip 包**，
`pip install libm2k` 装不上。

| 平台 | 安装 |
| --- | --- |
| Windows | 官网 libm2k 安装包自带 Python 绑定，装完选对应的 Python 版本 |
| Linux | Analog Devices 提供 .deb；或 `libiio` + `libm2k` 源码编译，`cmake -DENABLE_PYTHON=ON` |
| macOS | `brew install libiio`，libm2k 需源码编译并装 Python 绑定（最麻烦的一个） |

Python 用 **3.11**（Bridge 其余部分按 3.11 写的）。绑定装进哪个解释器就用哪个跑 Bridge，
虚拟环境下要确认 `libm2k` 能被 import：

```bash
cd apps/m2k-bridge
. .venv/bin/activate
python -c "import libm2k; print(libm2k.getVersion())"
```

import 不了的话 Bridge 不会崩，`/status` 会返回 `LIBM2K_MISSING` 并指向本文。

### 确认设备没被别人占用

ADALM2000 同一时间只能被一个进程独占。**Scopy 开着就连不上**，这是最常见的
「连不上设备」原因。

- Windows：关掉 Scopy，确认托盘里也没有
- Linux：`lsof /dev/bus/usb/*` 或 `ps aux | grep -i scopy`
- macOS：活动监视器里搜 Scopy

USB 也要确认认到了：

```bash
iio_info -s          # 应该列出 ADALM2000
```

Linux 上还要有 udev 权限，否则只有 root 能访问：

```bash
sudo cp /usr/share/libiio/*.rules /etc/udev/rules.d/ && sudo udevadm control --reload
```

### 切到真实硬件模式

```bash
cd apps/m2k-bridge
BRIDGE_MOCK=false pnpm bridge:dev
```

或直接：

```bash
BRIDGE_MOCK=false .venv/bin/uvicorn src.main:app --host 127.0.0.1 --port 3777
```

切过去之后 `/status` 会返回 `hardwareVerified=false` 与 `experimental=true`，
调试工作台顶部会出现「实验性硬件模式」横幅。**那个横幅在整份 checklist 走完
之前都不该消失。**

---

## 2. 设备发现

### `GET /status`

```bash
curl -s http://127.0.0.1:3777/status | python3 -m json.tool
```

| 情况 | 预期 |
| --- | --- |
| libm2k 没装 | `connected:false`，`detail` 含 `libm2k 未安装` |
| 装了但没插设备 | `connected:false`，`detail` 为 `libm2k 可用，但尚未连接设备` |
| 插了但没 connect | 同上（`/status` 不会自动连） |
| 已 connect | `connected:true`，`device:"ADALM2000"`，`serial` / `firmware` 非空 |

三种情况下 `mock` 都必须是 `false`、`adapter` 是 `real`、
`hardwareVerified` 是 `false`。

**记录**：`serial` 与 `firmware` 的实际返回值与类型。代码里假设它们是字符串，
如果 libm2k 返回的是别的东西，这里就会暴露。

### `GET /devices`

需要配对 token（见第 5 节）。

```bash
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:3777/devices
```

预期：列出至少一个 URI，形如 `usb:1.5.5` 或 `ip:192.168.2.1`。

### `POST /devices/connect`

```bash
curl -s -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:3777/devices/connect
```

| 现象 | 原因 |
| --- | --- |
| `NO_DEVICE` | 没插、没权限、或 Scopy 占着 |
| `LIBM2K_MISSING` | 绑定没装进当前解释器。`/devices` 也会报这个而不是「空列表」—— 空列表会把人引去查 USB 线 |
| 连上但 `serial` 为空 | `getSerialNumber` 的返回形状和假设不同 → **记下来，要改代码** |
| 超时 | USB 线是充电线不是数据线（真的很常见） |

---

## 3. 示波器

**空载先做。** 探头什么都不接，确认底噪与量纲。

1. **配置采样**

   ```bash
   curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"sampleRate":1000000,"timebaseSPerDiv":0.0005,"running":true}' \
     http://127.0.0.1:3777/scope
   ```

   记录：请求的 `sampleRate` 与设备实际生效的采样率是否一致。ADALM2000 的
   采样率是分档的，1MSPS 未必能精确落到。

2. **空载噪声**：连 WebSocket 取几帧，看 CH1/CH2 的 Vpp。

   ```bash
   # token 走 query，浏览器握手不能设 header
   websocat "ws://127.0.0.1:3777/ws?token=$TOKEN" | head -4
   ```

   预期：空载 Vpp 在几个 mV 量级。**如果是几百 mV 或者上千，多半是量纲错了
   （原始 ADC 码没转成电压），不是硬件坏了。**

3. **通道顺序**：只把探头接到 CH1，确认动的是 `ch1` 那条曲线。
   代码里假设 `getSamples` 返回 `[ch1, ch2]`，这个假设没验证过。

4. **单位**：接一个已知直流电平（比如 3.3V 稳压输出），确认读数接近 3.3
   而不是 3300 或 0.0033。

5. **W1 → CH1 loopback**：见第 4 节，做完 AWG 再回来做。

**记录**：空载 Vpp、通道顺序是否正确、单位是否为伏特、实际采样率。

---

## 4. AWG

> 从最小幅度开始。`0.4Vpp / 0V offset` 是安全起点，也正好是内置 Demo 的默认值。

1. **sine**

   ```bash
   curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"channel":"W1","wave":"sine","freqHz":1000,"amplitudeVpp":0.4,"offsetV":0}' \
     http://127.0.0.1:3777/awg
   ```

   **必须用独立示波器量实际输出**，不要只看 Bridge 自己的读数。

   ⚠️ **已知问题：`freqHz` 目前不生效。** 代码写死 75MSPS 采样率 / 1024 点
   缓冲，实际输出频率由这两者决定（约 73kHz），和请求的 1000Hz 无关。
   **把实测频率记进第 7 节** —— 修这个问题需要先知道实际值。

2. **dc**

   ```bash
   -d '{"channel":"W1","wave":"dc","freqHz":0,"amplitudeVpp":0,"offsetV":2.5,"confirm":true}'
   ```

   `offsetV != 0` 需要 `confirm:true`（见第 5 节）。量实际直流电平是否为 2.5V。

3. **square / triangle / sawtooth**

   ```bash
   -d '{"channel":"W1","wave":"square","freqHz":1000,"amplitudeVpp":0.4,"offsetV":0}'
   ```

   **预期：503，`code: "WAVEFORM_UNSUPPORTED"`。** 这三种波形没实现，现在会
   显式报错而不是静默按正弦输出 —— 静默按正弦输出比报错危险得多，调用方会
   以为自己拿到了方波。

   如果实测返回的是 200，说明有人把这个拦截去掉了，回退它。

4. **幅度与偏置上限**

   | 请求 | 预期 |
   | --- | --- |
   | `amplitudeVpp: 20` | 422，`LIMIT_EXCEEDED`（超硬件上限，`confirm` 也绕不过） |
   | `amplitudeVpp: 6`，无 `confirm` | 428，`CONFIRM_REQUIRED` |
   | `amplitudeVpp: 6`，`confirm:true` | 200，实测输出 6Vpp |
   | `offsetV: 2.5`，无 `confirm` | 428 |

5. **W1 → CH1 loopback**：杜邦线把 W1 直接接到 CH1（不接被测板），
   输出 0.4Vpp sine，确认示波器侧读到的 Vpp 与频率。这是唯一能同时验证
   AWG 与 Scope 两条链路的测试。

6. **停止输出**

   ```bash
   curl -s -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:3777/awg/disable
   ```

   量实际输出是否归零。

**记录**：sine 实测频率与幅度、dc 实测电平、loopback 结果、上限拦截是否生效。

---

## 5. 安全

**这一节先做，通过之后再接被测板卡。**

### 未配对不能控制

不带 token 请求，全部预期 401 `NOT_PAIRED`：

```bash
for p in /devices /awg /scope; do
  curl -s -o /dev/null -w "$p %{http_code}\n" -X POST http://127.0.0.1:3777$p
done
```

WebSocket 同样：`ws://127.0.0.1:3777/ws` 不带 token 应被 4401 关闭。

配对流程：`POST /pairing/start` → Bridge 控制台打印 6 位码 →
`POST /pairing/verify` 拿 token。

### emergency-stop 不需要 token

```bash
curl -s -X POST http://127.0.0.1:3777/emergency-stop
```

预期 200。**这是有意的**：急停因为 token 过期而失效，比没有急停更糟。
输出中时按下去，量实际输出是否立即归零。

### 二次确认

幅度 > 5Vpp 或 offset != 0 必须 428，且**前端也要弹确认框**。两层都要验：
前端拦不住的时候 Bridge 还能拦，反过来也一样。

### 断开设备后输出停止

输出中直接拔 USB。预期：

- Bridge 不崩
- `/status` 回到 `connected:false`
- 再次请求 `/awg` 返回 `NO_DEVICE`
- **物理输出停止**（拔线后设备断电，这条基本必然，但要确认）

重新插上后 `POST /devices/connect` 能恢复。

---

## 6. 自动化脚本

```bash
cd apps/m2k-bridge
. .venv/bin/activate

# 1) 只读检查（不开任何输出）
BRIDGE_TOKEN=<token> python scripts/hardware_smoke.py \
  --report hardware-report-readonly.json

# 2) loopback（W1 直连 CH1，会真的开 0.4Vpp 输出，需二次确认）
BRIDGE_TOKEN=<token> python scripts/hardware_smoke.py --loopback \
  --report hardware-report-loopback.json
```

> **token 用环境变量传。** 配对 token 是 base64url，可能以 `-` 开头，
> `--token <值>` 会被 argparse 当成选项名。要么用 `BRIDGE_TOKEN`，
> 要么写 `--token=<值>` 的等号形式。

怎么拿 token：

```bash
curl -sX POST http://127.0.0.1:3777/pairing/start      # Bridge 控制台打印 6 位码
curl -sX POST http://127.0.0.1:3777/pairing/verify \
  -H 'content-type: application/json' -d '{"code":"123456"}'
```

它跑第 2、3、5 节里能自动化的部分：状态、配对拦截、急停、token 有效性、
设备列表、连接、scope 配置、波形拦截、幅度上限。**默认不开任何输出**；
要做 loopback 得显式加 `--loopback`，并且会先要求确认。

不接硬件时它会清晰地失败并说明原因，不会崩。已验过的三条失败路径：

| 情况 | 表现 |
| --- | --- |
| Bridge 没起 | `连不上 Bridge（…）：Connection refused` + 启动命令，退出码 2 |
| token 无效/过期 | `配对 token 有效 ✗ 401 NOT_PAIRED` + 重新配对步骤，后续检查全跳过 |
| 没装 libm2k | `/devices` 返回 503 `LIBM2K_MISSING` 并指向本文 §1，不会报成「没有设备」 |
| 装了库但没插设备 | `/devices` 返回空列表，检查失败后停住，不继续跑硬件项 |

输出是 JSON 报告，直接贴进第 7 节。

```bash
python scripts/hardware_smoke.py --help
```

---

## 7. 记录表

### 当前状态：NOT RUN

最近一次核对：**2026-08-09**

```
操作系统：      macOS 26.5.2 (arm64)
Python：        3.11.4
libiio：        未安装（iio_info 不在 PATH）
libm2k：        未安装（ModuleNotFoundError: No module named 'libm2k'）
ADALM2000：     未连接（USB 枚举无 Analog Devices 设备）
```

因此下面的记录表**一项都没跑**。已经能确认的只有「不接硬件时脚本行为正确」：

```
$ BRIDGE_MOCK=false BRIDGE_REQUIRE_PAIRING=true uvicorn src.main:app --port 3781
$ BRIDGE_TOKEN=<token> python scripts/hardware_smoke.py --base http://127.0.0.1:3781

  ✓ /status 报告真实适配器      adapter=real connected=False | libm2k 未安装：No module named 'libm2k'
  ✓ 未配对拒绝 GET /devices     HTTP 401 code=NOT_PAIRED
  ✓ 未配对拒绝 POST /scope      HTTP 401 code=NOT_PAIRED
  ✓ 未配对拒绝 POST /awg        HTTP 401 code=NOT_PAIRED
  ✓ 急停无需 token 且返回 stopped HTTP 200 {'stopped': True}
  ✓ 配对 token 有效             HTTP 503
  ✗ /devices 列出设备           HTTP 503 {'code': 'LIBM2K_MISSING',
                                'message': "libm2k 未安装，无法枚举设备…安装步骤见 docs/10 §1"}

6/7 通过
```

**这不是硬件验证。** 它证明的是安全边界与脚本本身可用，不是 ADALM2000 能工作。

### 拿到硬件后填这里

```
日期：
执行人：
操作系统与版本：
Python 版本：
libiio 版本：           # iio_info -V
libm2k 版本：           # python -c "import libm2k; print(libm2k.getVersion())"
ADALM2000 序列号：
ADALM2000 固件版本：
```

| 项 | 结果 | 实测值 / 失败日志 |
| --- | --- | --- |
| 2 · `/status` 三种情况 | ☐ | |
| 2 · `/devices` 列出设备 | ☐ | |
| 2 · `connect` 成功且 serial/firmware 有值 | ☐ | |
| 3 · 空载噪声量级合理 | ☐ | Vpp = |
| 3 · 通道顺序正确 | ☐ | |
| 3 · 单位是伏特 | ☐ | |
| 3 · 实际采样率 | ☐ | 请求 1MSPS，实际 = |
| 4 · sine 实际输出频率 | ☐ | 请求 1000Hz，实测 = |
| 4 · sine 实际幅度 | ☐ | 请求 0.4Vpp，实测 = |
| 4 · dc 实际电平 | ☐ | 请求 2.5V，实测 = |
| 4 · square 返回 WAVEFORM_UNSUPPORTED | ☐ | |
| 4 · 20Vpp 被拒（LIMIT_EXCEEDED） | ☐ | |
| 4 · 6Vpp 无 confirm 被拒（428） | ☐ | |
| 4 · W1→CH1 loopback | ☐ | |
| 4 · disable 后输出归零 | ☐ | |
| 5 · 未配对无法控制 | ☐ | |
| 5 · emergency-stop 无需 token 且真的停 | ☐ | |
| 5 · 拔 USB 后不崩、输出停 | ☐ | |

上面每一项目前都是 ☐（未执行）。

### 能不能把 hardwareVerified 改成 true

**全部打勾，并且第 4 节的 `freqHz` 问题已经修掉**之后才可以。
只是「跑起来了」不够 —— 当前实现明确知道输出频率是错的，
在那之上宣称已验证，等于把一个已知错误标成正确。

改的地方：`apps/m2k-bridge/src/adapters/real_m2k.py` 里三处 `status()` 的
`hardware_verified` / `experimental`，以及
`apps/m2k-bridge/tests/test_bridge.py::test_real_adapter_reports_unverified`。
同时更新 README、`docs/07-operations.md` 与本文第 7 节。

改完前端的「实验性硬件模式」横幅会自动消失（它读的就是这两个字段）。
