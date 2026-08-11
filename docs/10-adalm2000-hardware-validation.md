# 10 · ADALM2000 真实硬件验证 checklist

`apps/m2k-bridge/src/adapters/real_m2k.py` 至今**没有在真实 ADALM2000 上跑过
一次**。代码结构完整、失败分支明确，但那不等于它能用。

**当前状态：NOT RUN**（本机没有 ADALM2000，也没装 libm2k / libiio，见第 7 节）。

> **2026-08-10 更新：适配器修了三处「写错了」而不只是「没验证」的问题。**
> 拿到硬件的同事请从第 6 节的脚本开始，它现在能自己回答「数据通道通了没有」。
>
> | 改动 | 老行为 | 现在 |
> | --- | --- | --- |
> | `freqHz` | **完全不生效**：写死 75MSPS/1024 点，恒输出 73.2kHz 且返回 200 | 按 `awg_plan` 算出采样率/点数/周期数，回报**实际频率**；做不到就报 `FREQ_UNREACHABLE` |
> | 波形 | 只有 sine 与 dc | 五种全支持，缓冲首尾可无缝循环 |
> | 相位 | **写死 176.8°**，真实硬件上永远显示这个数 | 从波形 FFT 真算，并绕回 ±180 |
>
> 新增两个端点，让联调不需要浏览器也不需要 WebSocket 客户端：
> `POST /scope/measure`（采一帧只回测量值）与 `GET /diagnostics`
> （每个可选 libm2k 调用的成败）。

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

## 1.5 重点验证项（先看这三条）

这三条是**我们对 libm2k 的假设**，写代码时无法确认，错了会让后面所有读数都不可信。
拿到硬件先验它们。

### 1.5.1 `aout.setCyclic` 的真实签名

代码里是 `self._aout.setCyclic(True)`，包在 `_try()` 里 —— 不同 libm2k 版本
可能需要通道参数（`setCyclic(chn, True)`），也可能根本没有这个方法。

**为什么要紧**：不设循环的话，AWG 把缓冲播完就停，输出变成**一个脉冲**而不是
连续波形。示波器上看到的是一条直线，很容易被当成「没有输出」。

| 检查 | 怎么做 | 记录 |
| --- | --- | --- |
| 方法是否存在 | `python -c "import libm2k; print([m for m in dir(libm2k.M2kAnalogOut) if 'yclic' in m])"` | ☐ |
| 签名要不要通道参数 | `help(libm2k.M2kAnalogOut.setCyclic)` | ☐ |
| `/diagnostics` 里显示什么 | 找 `aout.setCyclic` 那行是 `[OK ]` 还是 `[SKIP]` | ☐ |
| `[SKIP]` 时输出是什么样 | 示波器上看是连续波形还是单个脉冲 | ☐ |

若是 `[SKIP]` 且输出只有一个脉冲，把正确签名填进
`real_m2k.py` 的 `configure_awg`（那一行改掉即可，其余不动）。

### 1.5.2 `getAvailableSampleRates` 的真实返回

`awg_plan.py` 里有两张默认表，连接时会尝试用设备实际返回的表覆盖它们。
**如果实际表与默认表不同，所有频率规划都会偏。**

```bash
curl -s http://127.0.0.1:3777/diagnostics -H "authorization: Bearer $TOKEN" \
  | python3 -m json.tool | grep -A 12 AvailableRates
```

| 项 | 代码里的默认值 | 设备实际返回 | 一致？ |
| --- | --- | --- | --- |
| AWG（`aout`） | `750, 7500, 75000, 750000, 7500000, 75000000` | | ☐ |
| Scope（`ain`） | `1000, 10000, 100000, 1000000, 10000000, 100000000` | | ☐ |
| `aout.getAvailableSampleRates` 是否需要通道参数 | 代码传了 `0` | | ☐ |

不一致就把实际表填进 `awg_plan.py` 的 `DEFAULT_AWG_RATES` / `DEFAULT_SCOPE_RATES`
（作为兜底），并确认 `/diagnostics` 里那两行是 `[OK ]`。

### 1.5.3 `getSamples` 的返回形状与量纲

`_unpack()` 支持三种形状（两个列表 / 列优先 / 交织），判不出来会报错并打印
实际 shape。**拆错的表现是「波形看起来像噪声」**，很容易被当成硬件问题。

| 检查 | 期望 | 实测 | ☐ |
| --- | --- | --- | --- |
| 返回类型 | list / ndarray | | ☐ |
| shape | `(2, N)` | | ☐ |
| `/diagnostics` 里有没有 `已转置` / `已解交织` 的 note | 没有 | | ☐ |
| 量纲 | 伏特（接 3.3V 稳压读到 ≈3.3） | | ☐ |

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

**Scope 测量验证矩阵**

| # | 项 | 怎么验 | 期望 | 实测 | ☐ |
| --- | --- | --- | --- | --- | --- |
| 1 | CH1/CH2 通道顺序 | 只把信号接到 CH1 | `ch1` 有信号、`ch2` 接近 0 | | ☐ |
| 2 | `getSamples` 单位 | 接已知 3.3V 稳压输出 | 读数 ≈ 3.3（不是 3300 / 0.0033） | | ☐ |
| 3 | 1MSPS 可用 | `POST /scope {"sampleRate":1000000}` | 返回的 `sampleRate` = 1000000 | | ☐ |
| 4 | 10MSPS 可用 | 同上换 10000000 | 返回 10000000 | | ☐ |
| 5 | 空载噪声 | 探头悬空，`POST /scope/measure` | Vpp 在**几个 mV** 量级 | | ☐ |
| 6 | W1→CH1 loopback | 见第 6 节脚本 | 测到的 Vpp/频率 ≈ 请求值 | | ☐ |
| 7 | 双通道相位一致 | W1 同时接 CH1 与 CH2 | `phaseDeg` ≈ 0 | | ☐ |

第 5 项若是几百 mV 或上千，**多半是量纲错了（原始 ADC 码没转成电压），
不是硬件坏了**。

第 7 项是通道间偏斜的检查：同一个信号分给两个通道，相位差应该接近 0。
差得多说明两个通道不是同时采样的，那会让所有增益/相位测量失真。

一次采集的点数会影响频率读数的可信度：`measurements.ch1.freqResolutionHz`
是 `采样率 / 点数`，测到的频率和它同量级时读数不可信。1MSPS 下测 1kHz
至少要 8192 点（分辨率 122Hz）。

**记录**：上表 + 实际采样率。

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

   **预期 200**，五种波形都支持。返回体里带 `actualFreqHz` —— 用示波器确认
   波形形状确实是方波/三角/锯齿，而不是都长得像正弦。

   波形名写错（比如 `noise`）才返回 `WAVEFORM_UNSUPPORTED`。

4. **频率是否真的生效**（这一版的重点）

   拒绝行为（不用接示波器就能验）：

   | 请求 freqHz | 预期 |
   | --- | --- |
   | 25000000 | **503 `FREQ_UNREACHABLE`**，规格内但 75MSPS 合成不出可用波形 |
   | 50000000 | **422 `LIMIT_EXCEEDED`**，超器件绝对规格 |

   **AWG 输出验证矩阵** —— 每一行都要用独立示波器量。
   `actualFreqHz` 是我们算出来的，实测和它对不上就说明对 libm2k 的理解有误。

   | # | 请求 | `actualFreqHz` | 示波器实测频率 | 实测 Vpp | 实测 offset | 稳定循环 | 有无毛刺 |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 1 | sine 1Hz 0.4Vpp | | | | | ☐ | ☐ |
   | 2 | sine 10Hz 0.4Vpp | | | | | ☐ | ☐ |
   | 3 | sine 1kHz 0.4Vpp | | | | | ☐ | ☐ |
   | 4 | sine 100kHz 0.4Vpp | | | | | ☐ | ☐ |
   | 5 | sine 1MHz 0.4Vpp | | | | | ☐ | ☐ |
   | 6 | square 1kHz 0.4Vpp | | | | | ☐ | ☐ |
   | 7 | triangle 1kHz 0.4Vpp | | | | | ☐ | ☐ |
   | 8 | sawtooth 1kHz 0.4Vpp | | | | | ☐ | ☐ |
   | 9 | dc offset 0V | — | — | | | — | — |
   | 10 | dc offset 1V | — | — | | | — | — |
   | 11 | dc offset 2.5V（需 confirm） | — | — | | | — | — |

   低频那两行（1Hz / 10Hz）特别重要：它们用的采样率档位（750 / 7500）和
   1kHz 以上完全不同，档位选错在高频看不出来。

   「稳定循环」指连续观察十几秒波形不漂移、不中断 —— `setCyclic` 没生效的话
   这里会露馅（见 §1.5.1）。

   「有无毛刺」看每个周期的接缝处：缓冲首尾接不上会出现周期性的尖峰。
   锯齿的回扫沿是波形本身，不算毛刺。

   请求命令：

   ```bash
   curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"channel":"W1","wave":"sine","freqHz":1,"amplitudeVpp":0.4,"offsetV":0}' \
     http://127.0.0.1:3777/awg | python3 -m json.tool
   ```

5. **幅度与偏置上限**

   | 请求 | 预期 |
   | --- | --- |
   | `amplitudeVpp: 20` | 422，`LIMIT_EXCEEDED`（超硬件上限，`confirm` 也绕不过） |
   | `amplitudeVpp: 6`，无 `confirm` | 428，`CONFIRM_REQUIRED` |
   | `amplitudeVpp: 6`，`confirm:true` | 200，实测输出 6Vpp |
   | `offsetV: 2.5`，无 `confirm` | 428 |

6. **W1 → CH1 loopback**：杜邦线把 W1 直接接到 CH1（不接被测板），
   输出 0.4Vpp sine。这是唯一能同时验证 AWG 与 Scope 两条链路的测试，
   现在脚本会自己采一帧回来对比（见第 6 节）。

7. **停止输出**

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
设备列表、连接、scope 配置、**五种波形的实际输出频率**、幅度上限。
**默认不开任何输出**；要做 loopback 得显式加 `--loopback`，并且会先要求确认。

`--loopback` 现在会自己回答「数据通道通了没有」：开 0.4Vpp/1kHz →
启动示波器 → `POST /scope/measure` 采一帧 → 把测到的 Vpp 与频率和请求值对比。

```
  ✓ W1 输出 0.4Vpp/1kHz sine        HTTP 200 实际频率 1000.0Hz
  ✓ 启动示波器                       HTTP 200
  ✓ 采集一帧                         4096 点 @ 1000000Sa/s
  ✓ CH1 测到幅度 ≈ W1 输出           输出 0.4Vpp → 测到 0.39Vpp
  ✓ CH1 测到频率 ≈ W1 输出           输出 1000Hz → 测到 1000.0Hz
```

幅度用 ±20% 的宽松判据：探头衰减、量程档位、接触电阻都会影响。这一步回答的是
「通道通不通」，精确标定是人工那一步的事。频率用 ±5%，它不该受这些影响 ——
频率对不上就是采样率或频率规划有问题。

报告里还会带上 `/diagnostics`：**每个可选 libm2k 调用的成败都在里面**
（`calibrateADC` 成了没、`setRange` 认不认那个常量、`getSamples` 返回的形状），
真机排查时这是最有用的一列信息。

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

必须同时满足：

1. **§1.5 三条重点项全部确认**（`setCyclic` 签名、采样率表、`getSamples` 形状与量纲）
2. **§4 的 AWG 矩阵 11 行全部实测填完**，实测频率与 `actualFreqHz` 一致
3. **§3 的 Scope 矩阵 7 行全部实测填完**
4. §5 的安全项全过
5. 上面的记录表全部打勾

`freqHz` 的实现问题在 2026-08-10 那一版已经修掉（现在按采样率与缓冲长度规划，
1Hz~10MHz 数学上精确），但**数学正确不等于硬件正确** —— libm2k 那一层的
理解对不对，只有 §4 的矩阵能回答。

只是「跑起来了」不够。

改的地方：`apps/m2k-bridge/src/adapters/real_m2k.py` 里三处 `status()` 的
`hardware_verified` / `experimental`，以及
`apps/m2k-bridge/tests/test_bridge.py::test_real_adapter_reports_unverified`。
同时更新 README、`docs/07-operations.md` 与本文第 7 节。

改完前端的「实验性硬件模式」横幅会自动消失（它读的就是这两个字段）。
