# LabSight EVT0.4 — OpenAI + Gemini Dual Provider

面向硬件研发调试的浏览器原型：**Insta360 Link 2C / UVC Camera + KiCad + Vision + Voice + OpenAI/Gemini A/B Test**。

## 当前功能

- 浏览器直接选择 Insta360 Link 2C / 其他 UVC 摄像头和麦克风
- 4K 视频预览；发送 AI 前自动把当前帧压缩到最长边 2048 px
- KiCad 工程 ZIP 在浏览器本地解析，不把完整 ZIP 上传到 Vercel
- PCB / 示波器 / 实验仪器三种视觉分析模式
- 页面直接切换 **OpenAI / Gemini**，同一画面、同一 KiCad 上下文做 A/B 测试
- OpenAI：Responses API 视觉分析 + Audio transcription + 可选 Cloud TTS
- Gemini：Gemini API 视觉分析 + 音频理解/转写；回答默认使用浏览器本地 TTS
- Link 2C 麦克风自动优先选择
- “LabSight” 自动唤醒实验模式 + 60 秒连续对话

## Vercel 环境变量

至少配置一个 Provider；要做 A/B 测试则两个都配置：

```env
OPENAI_API_KEY=sk-...
OPENAI_VISION_MODEL=gpt-5.6-luna
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=marin

GEMINI_API_KEY=AIza...
GEMINI_VISION_MODEL=gemini-2.5-flash
GEMINI_AUDIO_MODEL=gemini-2.5-flash
```

模型名称都可以通过 Vercel Environment Variables 更换，无需修改前端。

## 部署到 Vercel

1. 在 Vercel 导入 `gongyueetree/board-debug-copilot`。
2. Production Branch 使用 `main`。
3. **Root Directory 设置为 `labsight-vercel`**。
4. Framework Preset 选择 **Other**。
5. Build Command / Output Directory 不要手工 Override，让仓库里的 `vercel.json` 接管。
6. 配置上面的 API Key。
7. Redeploy，并关闭旧 Build Cache 做一次全新部署。
8. 先检查 `https://<your-project>.vercel.app/api/health`。
9. 打开主页，允许 Camera 和 Microphone 权限。

## A/B 测试

页面顶部 **AI Provider** 选择：

- `OpenAI`
- `Gemini`

推荐固定同一块 PCB、同一个相机位置、同一个 KiCad 工程和同一句问题，分别跑两次。回答顶部会显示实际 Provider 和模型名，便于比较：

- 器件/丝印识别准确率
- 示波器数值读取准确率
- KiCad 上下文使用能力
- 故障推理质量
- 延迟
- 成本

## reCamera Pro 本地 Bridge

浏览器不能直接读取 RTSP。选择 `Seeed reCamera Pro（Wi‑Fi）` 后，页面通过仅监听本机的 RTSP→WebRTC Bridge 获取视频。

连接参数：

- reCamera IP：设备的局域网 IP，例如 `192.168.42.1`
- 用户名和密码：设备 RTSP 认证信息；页面不会持久化密码
- RTSP 路径：默认 `/main`，可按设备固件修改
- Bridge 端口：默认 `18765`，必须与启动 Bridge 时传入的 `--port` 一致

开发环境手动启动，不会注册开机启动：

```bash
python -m pip install -r tools/requirements-recamera-bridge.txt
python tools/recamera_webrtc_bridge.py --host 127.0.0.1 --port 18765
```

页面会先请求 `http://127.0.0.1:<Bridge 端口>/health`。显示“WebRTC 后台服务已就绪”后，再提交设备连接信息。Bridge 根据这些信息在本机生成：

```text
rtsp://<用户名>:<密码>@<设备 IP>:554<RTSP 路径>
```

Bridge 必须保持监听 `127.0.0.1`，不要改为局域网地址。

## 数据路径

```text
KiCad ZIP
  ↓ 浏览器本地 JSZip 解析
位号 / 网络 / 有限文本上下文
  └──────────────┐
                 ↓
Link 2C → 当前 JPEG 帧 → /api/analyze → OpenAI 或 Gemini
                 ↑
          Link 2C Mic / 用户问题
```

完整 KiCad ZIP 不会经过 Vercel API；当前分析帧、用户音频和有限工程上下文会发送给用户选择的 AI Provider。

## 自动唤醒说明

EVT0.4 仍然属于验证版：自动唤醒会周期性截取短音频并使用当前选定 Provider 转写，然后检测 `LabSight / Lab Sight / 莱布赛特 / 拉布赛特 / 小 Lab`。正式 Raspberry Pi 版本建议改为本地 Wake Word + VAD，休眠阶段不上传音频，也不消耗云 API。

## 下一步

- Raspberry Pi 5 本地 Wake Word / VAD
- Realtime / Live API 双向语音
- 自动稳帧与清晰度评分
- ROI：AI 或用户框选 U3 / TP4 / 示波器测量区域
- PCB 实物与 `.kicad_pcb` 坐标配准
- SCPI / USB / LAN 仪器数据接入
- A/B Test 结果自动记录：Provider、模型、延迟、成本、用户评分
