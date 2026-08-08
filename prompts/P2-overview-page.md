# P2 项目总览页

阅读 docs/03「页面1」。执行：

1. TanStack Query 封装 api client（contracts 类型共享）
2. 实现项目总览页全部区块：4 统计卡 / 设计概览(3 tab+内嵌原理图 SVG) / 最近测试波形(WaveformCanvas，Canvas+ResizeObserver+DPR，用 capture 摘要合成正弦渲染) / AI 调试参谋卡(静态渲染 seed 的诊断) / 高风险问题 / 调试记录时间线 / PCB 照片轮播
3. 通用组件进 packages/ui：RiskPill、StatCard、SectionCard、WaveformCanvas
4. 顶栏项目切换、设备状态(暂灰点未连接)、Ctrl+K 聚焦搜索框

验收：与效果图逐区块对照一致；无 mock 之外网络依赖；窗口缩放波形不模糊。
