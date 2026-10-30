# Tapo C113 接入 LabSight

Tapo C113 的网络视频通过本机 RTSP → WebRTC Bridge 进入现有的 LabSight 视频、抓图、AI 分析和语音提问链路。无需新增 Vercel 环境变量，也不需要 Tapo 云 API。

## 1. 配置摄像头

1. 在 Tapo App 中完成 C113 配网。电脑和摄像头连接到同一个局域网（避免访客 Wi-Fi 的设备隔离）。
2. 打开摄像头 → 设备设置 → 高级设置 → **摄像机账户 / Camera Account**，创建独立的用户名和密码。不是 TP-Link/Tapo App 登录账号。
3. 在设备设置 → 设备信息找到摄像头的 IP。建议在路由器中为它保留 DHCP 地址。
4. 关闭摄像头隐私模式，确认 App 中能看到画面。

## 2. 在打开网页的电脑上启动 Bridge

需要 Python 3.11 或 3.12。下载或更新本仓库，在终端进入 `labsight-vercel` 文件夹：

```bash
python3 -m venv .venv-recamera
source .venv-recamera/bin/activate
python -m pip install -r tools/requirements-recamera-bridge.txt
python tools/recamera_webrtc_bridge.py --host 127.0.0.1 --port 18765
```

保持终端运行，浏览器打开 `http://127.0.0.1:18765/health` 应显示 `ok: true`。
Windows 激活环境改为 `.venv-recamera\Scripts\activate`。

Mac 也可以运行已有脚本：

```bash
zsh tools/run-recamera-bridge.command
```

名称保留 reCamera 是为了兼容已有安装，同一个程序支持 Tapo。
如需登录 Mac 后自动启动，可运行 `zsh tools/install-recamera-service.command`。安装后不要移动仓库目录；移动后须重新安装服务。之前装过服务的用户需要更新代码并重新运行安装脚本，让后台加载新版程序。

**Bridge 必须运行在打开 LabSight 网页的电脑上。** 比如用 MacBook 打开网页，就在 MacBook 上运行，而不是只在 Mac mini 上运行。网页在 Vercel 上也可使用这个本地 Bridge；Vercel 不直接连接家里的摄像头。

## 3. 在 LabSight 连接

摄像头类型选择 **Tapo C113（Wi-Fi / RTSP）**，填写：

| 字段 | 内容 |
| --- | --- |
| 局域网 IP | 例如 `192.168.1.100`，不要带 `rtsp://` 或端口 |
| 摄像机账户 | 第 1 步创建的专用用户名 |
| 密码 | 第 1 步创建的专用密码 |
| RTSP 路径 | `/stream1` 高清；卡顿时可选择 `/stream2` 标清 |
| Bridge 端口 | 默认 `18765` |
| 麦克风 | Mac、Insta360 或其它电脑麦克风 |

点击“连接 Tapo C113”。允许浏览器访问本地网络；需要语音时允许麦克风权限。拒绝麦克风仍可看视频、抓图和文字提问。状态栏会显示实际收到的画面尺寸。

接通后可使用“抓取当前帧”“分析当前画面”“PCB Deep Vision”“发送 + 看当前画面”，继续使用原有 KiCad 工程上下文和语音链路。本次只增加当前摄像头的一个可选来源，不增加同时双画面模式。

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

代码测试覆盖：5 项 Python 测试（含合成视频通过真实 aiortc 回环 WebRTC 传输），以及 Chromium 界面测试（模拟信令/传输，使用真实 canvas 视频和现有 captureFrame 抓图）。浏览器测试覆盖参数切换、密码不持久化、无麦克风运行、断开/取消、错误脱敏和 USB 选项恢复；不等同于实机端到端验收。

复跑：

```bash
python -m unittest discover -s labsight-vercel/tests -p 'test_*.py'
# 已安装 Playwright 与 Chromium 的环境中：
node labsight-vercel/tests/camera-adapters.browser.cjs
```

**C113 实机、用户的 Vercel HTTPS → 本机网络权限、真实 AI/声网调用尚未在用户环境验收。** 请依次验收：画面出现 → 抓取一帧 → 文字提问分析 → 本机麦克风语音提问 → 断开/重连。

## 官方依据

- [TP-Link：使用 RTSP/ONVIF 在电脑、NAS 或 NVR 上查看 Tapo 摄像头](https://www.tp-link.com/us/support/faq/2680/)：适用型号包含 Tapo C113；摄像机账户、554 端口、`/stream1` 与 `/stream2`。
- [Tapo C113 产品页](https://www.tapo.com/us/product/smart-camera/tapo-c113/)

核对日期：2026-10-30。
