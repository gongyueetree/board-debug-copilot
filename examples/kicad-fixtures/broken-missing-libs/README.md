# broken-missing-libs

故意坏掉的工程。**通过的标准不是「解析成功」，而是「没崩、parseLog 说清楚了
发生什么」**（CLAUDE.md 硬性原则 #8）。

## 怎么坏的

- `U9` 的 `lib_id` 指向 `NoSuchLib:MissingPart`，而 `lib_symbols` 里没有它的定义
- `sym-lib-table` 指向一个不存在的 `.kicad_sym` 路径

## 验证什么

- `parseKicadArchive` 返回 status 而不是抛异常
- 缺失的符号被跳过，能解析的部分照常解析
- parseLog 可读，能定位到是哪一步、什么原因

## 已验证（kicad-cli 10.0.1）

- mode=cli，1 组件 / 3 网络（R1 解析出来了，U9 被 KiCad 跳过）
- ERC：19 条违规
- 原理图 SVG：1 张
- 全程无异常抛出


## 这个工程是怎么来的

手写 s-expression，然后**用真实 kicad-cli 10.0.1 逐个验证**：netlist 导出的
器件/网络、ERC 报告、SVG 页数都对得上 manifest 里的期望值。不是从 KiCad GUI
里存出来的，所以文件里没有 GUI 才会写的那些字段（视图位置、最近使用的库等），
但 kicad-cli 全流程都能吃。

连接全部用标签（同名标签即同一网络），不布线 —— 手写坐标最容易错的就是
「两条线差 0.01mm 没接上」，用标签就绕过了这一类问题。

改动请连 manifest 一起改，然后跑 `pnpm test:kicad-real` 确认。
