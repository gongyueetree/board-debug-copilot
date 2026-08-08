# P5 PCB 照片页

阅读 docs/03「页面4」。执行：

1. 照片上传 API（类型/大小校验）+ mock 对象存储 adapter；seed 内置 3 张 demo 照片（用生成的板卡示意图占位）
2. 左查看器：Konva 实现缩放/平移/矩形标注/编号圆标/图层开关；右 KiCad 设计视图（预制深色 SVG）
3. 对齐与映射状态三卡（seed alignmentJson 渲染）；备注表格 CRUD（PhotoAnnotation）
4. AI 视觉：POST /ai/analyze-photo → vision adapter（MOCK 返回 seed 5 条 VisualFinding；真实模式传图给多模态模型），结果列表+置信度+风险 pill
5. 「向 AI 提问」：快捷 chip + 输入框，走 /ai/chat mode=photo，上下文带当前照片标注

验收：可上传、标注、提问；检测结果与效果图字段一致；标注可关联到组件并出现在备注表。
