# simple-inverting-amp

基线 fixture。**全链路都应该通**，任何一项失败都说明解析链路真的坏了。

## 需要包含

- `*.kicad_pro`
- `*.kicad_sch`（单页）
- `*.kicad_pcb`（布好，能过 DRC）

## 建议电路

对齐内置 Demo：AD8605 单电源反相放大器，Rin=10k / Rf=100k，
外加去耦电容与两个测试点。5~10 个器件足够。

## 验证什么

- 三种工程文件都能识别
- netlist 导出成功，且能解析出 Component / Net / Pin
- ERC 与 DRC 报告能生成并归一化成受控 code
- 原理图与 PCB 各至少保存一个 SVG
