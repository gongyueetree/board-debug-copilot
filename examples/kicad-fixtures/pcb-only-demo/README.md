# pcb-only-demo

只上传 `.kicad_pcb` 的情况：改板、只拿到 layout、或者原理图在别的工具里。

## 内容

`pcb-only.kicad_pcb` + `pcb-only.kicad_pro`，**没有 `.kicad_sch`**。
3 个 0603 封装，3 个网络（VIN / VOUT / GND）。

## 验证什么

- PCB SVG 正常产出
- 没有 netlist 与 ERC，但这**不是错误**：项目状态仍是 READY，设计数据保持
  原样（`parseKicadArchive` 的降级分支）
- `expectedMode: "mock"` —— 没有 netlist 就没有结构化数据，走的就是降级路径

## 已验证（kicad-cli 10.0.1）

- mode=mock，0 组件 / 0 网络，不报错
- PCB SVG：1 张
- parseLog 里能读到「netlist: 未找到，无法提取结构化数据」


## 这个工程是怎么来的

手写 s-expression，然后**用真实 kicad-cli 10.0.1 逐个验证**：netlist 导出的
器件/网络、ERC 报告、SVG 页数都对得上 manifest 里的期望值。不是从 KiCad GUI
里存出来的，所以文件里没有 GUI 才会写的那些字段（视图位置、最近使用的库等），
但 kicad-cli 全流程都能吃。

连接全部用标签（同名标签即同一网络），不布线 —— 手写坐标最容易错的就是
「两条线差 0.01mm 没接上」，用标签就绕过了这一类问题。

改动请连 manifest 一起改，然后跑 `pnpm test:kicad-real` 确认。
