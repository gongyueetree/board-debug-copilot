# P7 测试报告页

阅读 docs/03「页面6」。**注意：报告页效果图里的 ADuCM4050 / 运放 U2A / Q3 过热 / L1 EMI 属于另一块板，只取版式，内容一律来自本项目 seed（见 docs/05 §16.2）。** 执行：

1. report agent + report worker：聚合项目摘要/审查/照片/测量/诊断/过程/结论 → Markdown + tocJson + statsJson，POST /projects/:id/reports
2. 页面三栏：目录树(锚点滚动+更新目录+自定义章节)、A4 纸样渲染(markdown-it/自定义渲染器，表格/统计pill/波形小图/照片特写按 docs/03 版式)、右设置面板(标题/作者/版本/日期/封面 + 导出选项 + AI 报告摘要 + 生成报告按钮)
3. 导出：Markdown 下载可用；PDF/DOCX 按钮显示「即将支持」
4. 大纲视图 tab：纯目录+摘要模式

验收：一键生成报告与效果图版式一致；下载 .md 内容完整；重新生成覆盖旧版本并 version+1。
