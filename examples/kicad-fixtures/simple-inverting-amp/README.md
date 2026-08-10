# simple-inverting-amp

基线 fixture：单页反相放大器。**全链路都应该通**，任何一项失败都说明解析链路
真的坏了。

## 内容

| 位号 | 值 | 说明 |
| --- | --- | --- |
| U1 | AD8605 | 运放，5 脚（OUT / − / + / V− / V+） |
| R1 | 10k | Rin：VIN → INV |
| R2 | 100k | Rf：INV → VOUT，增益 −10 |
| C1 | 100nF | +5V 去耦 |
| TP1 | TP_VIN | 输入测试点 |
| TP2 | TP_VOUT | 输出测试点 |

网络：`VIN` `INV` `VOUT` `VREF` `GND` `+5V`（6 个）

配套 `.kicad_pcb` 有 3 个 0603 封装与板框，够 `pcb export svg` 出图。

## 已验证（kicad-cli 10.0.1）

- netlist：6 组件 / 6 网络
- ERC：29 条违规（大多是「没有 power flag」这类，属预期）
- 原理图 SVG：1 张
- PCB SVG：1 张
- **DRC：未产出** —— KiCad 10.0.1 的 `pcb drc` 会挂死，见 docs/08 §6。
  manifest 里 `expectDrc: false` 记的就是这件事。


## 这个工程是怎么来的

手写 s-expression，然后**用真实 kicad-cli 10.0.1 逐个验证**：netlist 导出的
器件/网络、ERC 报告、SVG 页数都对得上 manifest 里的期望值。不是从 KiCad GUI
里存出来的，所以文件里没有 GUI 才会写的那些字段（视图位置、最近使用的库等），
但 kicad-cli 全流程都能吃。

连接全部用标签（同名标签即同一网络），不布线 —— 手写坐标最容易错的就是
「两条线差 0.01mm 没接上」，用标签就绕过了这一类问题。

改动请连 manifest 一起改，然后跑 `pnpm test:kicad-real` 确认。
