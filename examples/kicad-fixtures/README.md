# KiCad 真实工程 fixture

给 `pnpm test:kicad-real` 用。目的只有一个：**在装了 KiCad CLI 的机器上，
用真实工程验证 `packages/kicad` 的解析链路**，而不是继续靠 mock 自证。

内置 Demo（`Sensor Board Debug Demo`）不依赖这里的任何文件 —— 它跑的是 seed
数据，`MOCK_MODE=true` 下无 KiCad CLI 也能完整演示。两条路互不影响。

## 现状

四个 fixture 目前**都是占位**：只有 `manifest.json` 与说明，没有真实工程文件。
`pnpm test:kicad-real` 会把它们逐个报成 `PLACEHOLDER`，不会假装通过。

放进真实工程文件后，运行器自动开始对它做断言 —— 不需要改代码。

## 目录约定

```
examples/kicad-fixtures/
  <fixture-name>/
    manifest.json      必需。声明这个 fixture 该被解析成什么样
    README.md          必需。这个 fixture 用来验证什么、怎么造出来的
    project/           真实 KiCad 工程文件放这里（放进来即生效）
      *.kicad_pro
      *.kicad_sch
      *.kicad_pcb
      *.kicad_sym / *.pretty/  （可选，看 fixture 目的）
```

运行器会把 `project/` 整个打成 zip，走和线上上传完全相同的路径：
`safeUnzip` → `parseProject`（kicad-cli）→ 产物入库 → netlist 转
Component/Net/Pin → ERC/DRC 转 RuleViolation。

## manifest.json

```jsonc
{
  "status": "placeholder",        // 放进真实工程后改成 "ready"
  "kicadVersion": "9.0",          // 工程用哪个版本存的
  "description": "单页反相放大器，最小可解析工程",
  "expect": {
    "hasPro": true,               // 能识别 .kicad_pro
    "hasSch": true,
    "hasPcb": true,
    "minComponents": 5,           // netlist 至少解析出几个组件
    "minNets": 4,
    "minSchematicSvgs": 1,        // 至少保存几个原理图 SVG
    "minPcbSvgs": 1,
    "netlist": true,              // 必须导出 netlist
    "erc": true,                  // 必须产出 ERC 报告
    "drc": true,
    "mustNotCrash": true          // 解析失败也必须返回 parseLog 而不是抛异常
  }
}
```

`expect` 里没写的字段一律不断言。缺库、缺 PCB 这类 fixture 就是靠把对应字段
写成 `false` 或 `0` 来表达预期的。

## 四个 fixture 各自验证什么

| fixture | 验证点 |
| --- | --- |
| `simple-inverting-amp` | 基线：单页原理图 + PCB，netlist / ERC / DRC / 两种 SVG 全通 |
| `multi-sheet-demo` | 多页原理图必须保存**多个** SVG（早先按单文件读，遇到目录直接崩） |
| `pcb-only-demo` | 只有 `.kicad_pcb`：DRC 与 PCB SVG 应该有，netlist 应该没有，且不算失败 |
| `broken-missing-libs` | 缺符号库/封装库：必须降级并写清楚 parseLog，不能让项目挂掉 |

## 怎么造 fixture

1. 用 KiCad 9 新建工程，画到刚好够验证目标为止 —— 越小越好，仓库里不需要
   一块真实产品板。
2. 存盘后把工程目录整个复制到 `<fixture>/project/`。
3. **删掉 `-backups/`、`fp-info-cache`、`*.kicad_prl`**：那是本地状态，不该进仓库。
4. 把 `manifest.json` 的 `status` 改成 `ready`，按实际结果填 `expect`。
5. 跑 `pnpm test:kicad-real` 确认通过，把用的 KiCad 版本记进
   `docs/08-real-kicad-validation.md` 的已验证表。

`broken-missing-libs` 是故意坏的：正常造好工程后，把它引用的符号库文件删掉，
或者把 `sym-lib-table` 指向一个不存在的路径。

## 体积

单个 fixture 建议 < 200KB。Gerber、3D 模型、备份目录都不要提交 ——
这里验的是解析链路，不是渲染效果。
