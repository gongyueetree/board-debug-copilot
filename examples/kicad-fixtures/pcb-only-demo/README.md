# pcb-only-demo

只上传 `.kicad_pcb` 的情况（改板、只拿到 layout、或者原理图在别的工具里）。

## 需要包含

- `*.kicad_pro`
- `*.kicad_pcb`
- **不要** `.kicad_sch`

## 验证什么

- DRC 与 PCB SVG 正常产出
- 没有 netlist 与 ERC，但这不是错误：项目状态仍是 READY，
  设计数据保持原样（`parseKicadArchive` 的降级分支）
- parseLog 里能看清「为什么没有 netlist」
