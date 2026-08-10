# multi-sheet-demo

专门盯一个真实踩过的坑：`kicad-cli sch export svg --output <dir>` 对多页原理图
写的是**目录**，而早先的实现把 `--output` 的参数当文件路径直接 readFile，
遇到目录整条解析会挂。

## 需要包含

- `*.kicad_pro`
- 根 `*.kicad_sch` + **至少两个** 子图（层次化原理图）
- PCB 可有可无

## 验证什么

- `schematicSvgPaths` 长度 >= 2
- 每一页各自登记成一条 `ProjectFile`，`filename` 是实际文件名而不是
  `--output` 传进去的那个参数
- netlist 跨页的连接正确（子图之间的层次标签能连上）
