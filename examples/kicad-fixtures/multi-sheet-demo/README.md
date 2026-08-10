# multi-sheet-demo

专门盯一个真实踩过的坑：多页原理图。

## 结构

```
multi-sheet.kicad_sch   顶层：TP1 / TP2
├── amp.kicad_sch       U1 AD8605 + R1 10k + R2 100k
└── psu.kicad_sch       C2 10uF + R3/R4 分压产生 VREF
```

跨页连接用 global label（`+5V` / `GND` / `VREF`），不用层次引脚 —— 少一层
「引脚位置要对上」的手写坐标风险，连通性一样是跨页的。

## 它抓到过什么

跑这个 fixture 时抓到两个真 bug：

1. **`--output` 当文件路径读**：`sch export svg` 对多页工程写的是目录，
   早先的实现直接 `readFile` 那个路径，整条解析会挂。
2. **挑错了根图**：压缩包里有 3 个 `.kicad_sch`，`find()` 到的是
   `amp.kicad_sch`（字母序在前）。导出的 netlist 只有子图那 3 个器件、
   SVG 只有 1 页 —— 而且**不报错**，只是安静地少一半数据。
   修法见 `pickRoot()`。

## 已验证（kicad-cli 10.0.1）

- netlist：8 组件 / 8 网络（跨三页）
- 原理图 SVG：**3 张**（顶层 + Amplifier + Power）
- PCB SVG：1 张


## 这个工程是怎么来的

手写 s-expression，然后**用真实 kicad-cli 10.0.1 逐个验证**：netlist 导出的
器件/网络、ERC 报告、SVG 页数都对得上 manifest 里的期望值。不是从 KiCad GUI
里存出来的，所以文件里没有 GUI 才会写的那些字段（视图位置、最近使用的库等），
但 kicad-cli 全流程都能吃。

连接全部用标签（同名标签即同一网络），不布线 —— 手写坐标最容易错的就是
「两条线差 0.01mm 没接上」，用标签就绕过了这一类问题。

改动请连 manifest 一起改，然后跑 `pnpm test:kicad-real` 确认。
