# P4 M2K Bridge + 调试工作台

阅读 docs/03「页面3」、docs/01 Bridge 协议。执行：

1. apps/m2k-bridge 完整实现：/status /devices，POST /awg /scope，WS /ws 推送波形帧+测量帧；BRIDGE_MOCK=true 用 numpy 合成，**5 个场景数值严格对齐 docs/05 §11.1**（normal / gain_error 默认 / clipping / noisy / no_response），经 /debug/scenario 切换，噪声用固定随机种子保证可复现；只绑定 127.0.0.1，校验 Origin
2. packages/instrument-protocol：WS/REST 消息 TS 类型 + pydantic 对应模型
3. 调试工作台页：左(接线指南SVG+检查清单+信号源表单+3预设+应用按钮)、中(时域 WaveformCanvas 双通道 + FftCanvas(自实现 FFT+Hann 窗，窗函数真实影响噪底) + 测量结果网格 + 仪器控制条)、右(AI 调试参谋：把最新测量帧 POST /ai/analyze-capture 获取解读)、底部状态栏
4. 顶栏设备状态联动 /status；断开时显示启动 Bridge 引导
5. 危险确认：幅度>5Vpp 或偏置≠0 弹二次确认；保存捕获 → POST /captures（仅摘要，波形数组暂存对象存储 mock）

验收：无硬件跑通全流程；切 `clipping` 场景后 AI 面板提示削顶并建议把 W2 降到 ≤0.45Vpp；切 `gain_error` 后提示增益不符且**不**误判为削顶（THD+N 0.35% 且未贴轨）；FFT 主峰在 1kHz。
