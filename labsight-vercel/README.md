# LabSight EVT0.2 — Vercel Prototype

一个面向硬件研发调试的浏览器原型：**Insta360 Link 2C / UVC Camera + KiCad + Vision + Voice**。

## 当前功能

- 浏览器直接选择 Insta360 Link 2C / 其他 UVC 摄像头和麦克风
- 4K 视频预览；发送 AI 前自动把当前帧压缩到最长边 2048 px
- KiCad 工程 ZIP 在浏览器本地解析，不把完整 ZIP 上传到 Vercel
- PCB / 示波器 / 实验仪器三种视觉分析模式
- 当前画面 + KiCad 上下文 + 用户问题一起送入 OpenAI Responses API
- 麦克风录音 → 转写 → 自动带当前画面提问
- 浏览器语音或 OpenAI TTS 回答

## 为什么针对 Vercel 做了改造

Vercel Function 请求体有 4.5MB 限制，因此本版本不再把 80MB 级 KiCad ZIP 发到 Python Function。工程文件由 JSZip 在浏览器中解析，只把有限的工程文本上下文随 AI 请求发送。4K 摄像头仍用于本地预览，AI 截图会压缩到最长边 2048px，以避免函数 payload 过大。

## 部署到 Vercel

这个原型当前位于 `board-debug-copilot` 仓库的 `labsight-vercel/` 子目录。

1. 在 Vercel 导入 `gongyueetree/board-debug-copilot`。
2. Branch 选择 `labsight-vercel-evt0`（测试阶段）；合并 PR 后可改回 `main`。
3. **Root Directory 设置为 `labsight-vercel`**。
4. Framework Preset 选择 **Other**（通常自动识别即可）。
5. 在 **Settings → Environment Variables** 添加：
   - `OPENAI_API_KEY`
   - 可选 `OPENAI_VISION_MODEL=gpt-5.6-luna`
   - 可选 `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
   - 可选 `OPENAI_TTS_MODEL=gpt-4o-mini-tts`
   - 可选 `OPENAI_TTS_VOICE=marin`
6. Redeploy。
7. 打开 `https://<your-project>.vercel.app`，允许 Camera 和 Microphone 权限。

API 健康检查：`https://<your-project>.vercel.app/api/health`

## 本地运行

推荐使用 Vercel CLI：

```bash
npm i -g vercel
vercel dev
```

然后访问 `http://localhost:3000`。

## 目录

```text
.
├── index.html
├── app.js
├── styles.css
├── api/
│   └── index.py
├── requirements.txt
├── .python-version
└── .env.example
```

## 隐私 / 数据路径

```text
KiCad ZIP
  ↓ 浏览器本地 JSZip 解析
位号 / 网络 / 有限文本上下文
  └────────────┐
               ↓
Link 2C → 当前 JPEG 帧 → /api/analyze → OpenAI
               ↑
          用户语音/问题
```

完整 KiCad ZIP 不会经过 Vercel API；当前分析帧和有限工程上下文会发送给配置的 AI API。

## 下一步建议

- Realtime API / WebRTC 双向实时语音
- 自动稳帧与清晰度评分，只在画面稳定时分析
- ROI：让用户或 AI 框选 U3 / TP4 / 示波器测量区域
- PCB 实物与 `.kicad_pcb` 坐标配准
- SCPI / USB / LAN 仪器数据接入，让数值来自仪器，视觉负责理解现场
