# Tapo C113 接入 LabSight

Tapo C113 的网络视频通过本机 RTSP → WebRTC Bridge 进入现有的 LabSight 视频、抓图、AI 分析和语音提问链路。无需新增 Vercel 环境变量，也不需要 Tapo 云 API。

## 1. 配置摄像头

1. 在 Tapo App 中完成 C113 配网。电脑和摄像头连接到同一个局域网（避免访客 Wi-Fi 的设备隔离）。
2. 打开摄像头 → 设备设置 → 高级设置 → **摄像机账户 / Camera Account**，创建独立的用户名和密码。不是 TP-Link/Tapo App 登录账号。
3. 在设备设置 → 设备信息找到摄像头的 IP。建议在路由器中为它保留 DHCP 地址。
4. 关闭摄像头隐私模式，确认 App 中能看到画面。

## 2. 在打开网页的电脑上启动 Bridge

Mac 需要 Python 3.11 或 3.12。默认 `python3` 可能是其它版本，旧虚拟环境也可能绑定了不兼容的版本，导致 PyAV 被迫源码编译。

已安装 Homebrew 时，先运行：

```bash
brew install python@3.12
```

没有 Homebrew 时，可从 python.org 安装 Python 3.12 的 macOS universal2 安装包。然后在 `labsight-vercel` 目录运行：

```bash
zsh tools/run-recamera-bridge.command
```

新版脚本自动寻找 Python 3.12/3.11，建立独立的 `.venv-recamera-py3.12`（或 `py3.11`）环境，不复用、不删除旧的 `.venv-recamera`；安装时只接受预编译包，无需安装 FFmpeg、Cython 或 pkg-config 来编译 PyAV。如果找不到包，会显示 Python/系统/架构信息并停止，方便排查镜像或系统兼容问题。

已经下载旧 ZIP、暂不重新下载时，可在当前 `labsight-vercel` 目录直接执行以下等效命令（需要 Homebrew）：

```bash
brew install python@3.12
"$(brew --prefix python@3.12)/bin/python3.12" -m venv .venv-tapo312
.venv-tapo312/bin/python -m pip install --upgrade pip
.venv-tapo312/bin/python -m pip install --only-binary=:all: -r tools/requirements-recamera-bridge.txt
.venv-tapo312/bin/python tools/recamera_webrtc_bridge.py --host 127.0.0.1 --port 18765
```

保持终端运行，浏览器打开 `http://127.0.0.1:18765/health` 应显示 `ok: true`。

Windows 用户使用 `py -3.12 -m venv .venv-recamera`，再使用 `.venv-recamera\Scripts\python -m pip install --only-binary=:all: -r tools/requirements-recamera-bridge.txt` 和 `.venv-recamera\Scripts\python tools/recamera_webrtc_bridge.py`。

名称保留 reCamera 是为了兼容已有安装，同一个程序支持 Tapo。
如需登录 Mac 后自动启动，可运行 `zsh tools/install-recamera-service.command`。安装后不要移动仓库目录；移动后须重新安装服务。之前装过服务的用户需要更新代码并重新运行安装脚本，让后台加载新版程序。

**Bridge 必须运行在打开 LabSight 网页的电脑上。** 比如用 MacBook 打开网页，就在 MacBook 上运行，而不是只在 Mac mini 上运行。网页在 Vercel 上也可使用这个本地 Bridge；Vercel 不直接连接家里的摄像头。

## 3. 在 LabSight 连接

在“用于 PCB”或“用于仪器”区域选择 **Tapo C113（Wi-Fi / RTSP）**，点击连接，在弹窗中填写：

| 字段 | 内容 |
| --- | --- |
| 局域网 IP | 例如 `192.168.1.100`，不要带 `rtsp://` 或端口 |
| 摄像机账户 | 第 1 步创建的专用用户名 |
| 密码 | 第 1 步创建的专用密码 |
| RTSP 路径 | `/stream1` 高清；卡顿时可选择 `/stream2` 标清 |
| Bridge 端口 | 默认 `18765` |
| 麦克风 | Mac、Insta360 或其它电脑麦克风 |

点击弹窗中的“连接”，成功后配置窗口自动关闭；重新配置时点击“重新连接”。取消或按 Esc 关闭配置窗口不会中断尚未提交重连的现有画面。允许浏览器访问本地网络；需要语音时允许麦克风权限。拒绝麦克风仍可看视频、抓图和文字提问。状态栏会显示实际收到的画面尺寸。

接通后可使用抓图、分析和“发送 + 看当前画面”，继续使用原有 KiCad 工程上下文。现在支持同时连接两路摄像头：

## 4. 同时看 PCB 和仪器

1. 在左侧 **① 用于 PCB** 和右侧 **② 用于仪器** 中分别选择承担该用途的设备。两侧选项完全相同：USB / UVC、IMX415、Tapo C113、reCamera。C113 也可用于 PCB，USB 也可用于仪器；没有固定型号绑定。
2. USB 选择实际设备后直接连接。Tapo/reCamera 点击连接后弹出配置窗口，填写 IP、摄像机账户、密码、码流和 Bridge 端口；C113 通常使用 `/stream1` 和 `18765`。主界面不再常驻这些参数，也不显示无关的 USB 设备列表。
3. 顶部“提问 / 抓图范围”默认自动使用已连接画面。也可选“仅 PCB”“仅仪器”或“PCB + 仪器”。
4. 输入问题，例如：“结合 PCB 和示波器读数，下一步该测哪个位置？”点击发送。两路图片分别标注来源和截图时间，共用 KiCad 上下文。
5. 每路可独立抓图、放大、重连或断开。只有一路时仍可用；明确选择两路但有一路离线时会提示连接，不会复用旧帧。

首次使用两侧都默认 USB；后续记住各侧选择的类型。USB + C113 只需运行一个 Bridge；已有 `/health` 显示 `version: 0.3.0` 的服务无需重新安装。两路也可分别选择不同 USB 设备或网络摄像头；同一 USB 设备不能同时占用两路。原来的非密码 Tapo 设置会在同一浏览器/网站地址下复制到仪器槽位一次。

PCB 位号叠加、对齐与 **PCB Deep Vision** 始终使用左侧 PCB 画面。麦克风和扬声器设备选择统一放在顶部可展开的“麦克风 / 扬声器”中。普通文字提问和浏览器 ASR 转文字后的提问使用当前选择范围；独立声网实时 A6 通道的多画面传输不在本次验收范围内。只连仪器时可点“连接麦克风”启用电脑麦克风。

两路截图在浏览器中连续抓取，**不是硬件同步采样**，不能用于精确跨画面的时序测量。分析图片按大小压缩，与实时预览分开；需要仪器细字时使用“仅仪器”，调整拍摄距离与光线。

## 5. 未来迁移到树莓派

- **在树莓派上打开网页**：USB 摄像头由该浏览器访问；Tapo 视频经树莓派本机 Bridge 转为 WebRTC，流程与 Mac 相同，但需验证 Linux 摄像头权限、ARM 依赖及双路性能。
- **树莓派采集、Mac 打开网页**：当前版本尚不支持。网页的 `127.0.0.1` 指向 Mac，不是树莓派，需要后续增加带配对认证的远程采集连接。
- Mac 的 `.command`/launchd 自启动安装器不能原样用于树莓派。树莓派需要 Linux 安装与服务配置；此版本尚未提供或验证。

请勿直接将现有 Bridge 改为公网监听来代替远程采集适配。

## 数据与边界

- 视频：C113 → 局域网 RTSP → 本机 Bridge → WebRTC → 浏览器。
- 摄像机账户只提交到本机 Bridge；密码不写入 localStorage、不发送至 Vercel/AI。IP、用户名、路径按 Tapo/reCamera 分别记忆。密码在本次页面会话中保留便于重连，切换类型或刷新页面后需重填。
- 触发分析、自动场景识别或现有实时语音功能时，画面/音频仍按原来的 LabSight 功能发送到对应后端/模型服务。接入本地视频不改变这些行为。
- 本次不接入 Tapo 相机麦克风、双向对讲、录像回放、ONVIF 控制或自动对焦控制。
- 不要把 RTSP 554 或 Bridge 18765 端口映射到公网。Bridge 只监听本机；仅在可信的 LabSight 页面使用。
- 原始视频清晰度取决于摄像头固件、画质设置、镜头距离和光线。显示仪器读数与 PCB 微小丝印的效果需要实测，不能把支持接入等同于微距成像验证。

## 排查

| 现象 | 检查 |
| --- | --- |
| Bridge 未就绪 | 打开本机 `/health`；确认终端/服务在运行、端口一致，允许网站访问本地网络。优先使用桌面 Chrome/Edge；浏览器策略不同时按浏览器提示处理。 |
| HTTP 502 / 认证失败 | 确认是摄像机账户而不是 TP-Link 账号；检查 IP、隐私模式和 `/stream1`。可先用 VLC 在同一电脑测试 RTSP。 |
| 有协商但没有画面 | 检查本机防火墙、Wi-Fi 设备隔离；试 `/stream2`；关闭其它正在播放的 VLC、NVR 或 App，排除并发限制。 |
| 从外地无法连接 | 当前路径需要电脑能访问摄像头所在局域网；此版本不提供跨网中继。 |
| 没有语音 | 单独选择本机麦克风并允许权限；不使用 Tapo 内置麦克风。 |
| 切换电脑后失败 | 每台打开网页的电脑都要运行本机 Bridge。 |

## 验证状态

代码测试覆盖：12 项 Python 测试（含真实 aiortc 回环双路传输、独立断开、单图兼容、来源/大小校验、两个模型接口的双图请求），以及两组 Chromium 界面测试。浏览器使用模拟信令/传输和真实 canvas 视频，覆盖独立连接、不同颜色的双图证据、离线不复用旧图、单路回退、USB 设备占用、麦克风、PCB 画布隔离、两侧反向分配设备、连接弹窗/取消保持已有画面、选择记忆及桌面/手机布局；不等同于双摄硬件端到端验收。

复跑：

```bash
python -m unittest discover -s labsight-vercel/tests -p 'test_*.py'
# 已安装 Playwright 与 Chromium 的环境中：
node labsight-vercel/tests/camera-adapters.browser.cjs
node labsight-vercel/tests/dual-camera.browser.cjs
```

用户已反馈 Mac 单路 C113 显示 2304×1296 画面。**新增双摄、真实 AI/声网调用和树莓派尚未实机验收。** 双摄验收顺序：两路画面出现 → 分别抓图 → 两路一起文字提问 → 仅仪器提问 → 断开一路确认另一路继续 → 本机麦克风提问。

## 官方依据

- [TP-Link：使用 RTSP/ONVIF 在电脑、NAS 或 NVR 上查看 Tapo 摄像头](https://www.tp-link.com/us/support/faq/2680/)：适用型号包含 Tapo C113；摄像机账户、554 端口、`/stream1` 与 `/stream2`。
- [Tapo C113 产品页](https://www.tapo.com/us/product/smart-camera/tapo-c113/)

核对日期：2026-10-30。
