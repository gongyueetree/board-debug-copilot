# KiCad 真实工程 fixture

给 `pnpm test:kicad-real` 用。目的只有一个：**在装了 KiCad CLI 的机器上，
用真实工程验证 `packages/kicad` 的解析链路**，而不是继续靠 mock 自证。

内置 Demo（`Sensor Board Debug Demo`）不依赖这里的任何文件 —— 它跑的是 seed
数据，`MOCK_MODE=true` 下无 KiCad CLI 也能完整演示。两条路互不影响。

## 现状

四个 fixture 都有真实工程文件，并且**已在 kicad-cli 10.0.1 上跑通 4/4**
（macOS，2026-08-09，见 `docs/08-real-kicad-validation.md` §4）。

文件是手写 s-expression 后用真实 kicad-cli 逐个验证出来的，不是从 GUI 存的。
连接全部用同名标签，不布线 —— 手写坐标最容易错的就是「两条线差 0.01mm
没接上」。

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
  "name": "simple-inverting-amp",
  "description": "单页反相放大器：解析链路的基线用例",
  "status": "ready",                 // 还没放工程文件时写 "placeholder"
  "kicadVersion": "10.0.1",          // 用哪个版本验过

  "expectedComponentsMin": 6,        // netlist 至少解析出几个组件（下限）
  "expectedNetsMin": 6,              // 至少几个网络（下限）
  "expectedSchematicSvgCount": 1,    // 原理图 SVG 张数（精确值）
  "expectedPcbSvgCount": 1,          // PCB SVG 张数（精确值）
  "expectedMode": "cli",             // cli = 走通了 CLI；mock = 降级
  "allowWarnings": true,             // false 则 parseLog 里出现 WARN/ERR 即失败
  "shouldNotCrash": true,            // 必须返回 status + 可读 parseLog，不能抛

  "expectNetlist": true,             // 必须产出 netlist
  "expectErc": true,
  "expectDrc": false,                // KiCad 10 的 pcb drc 会挂死，见 docs/08 §6
  "parseLogMentions": ["erc"],       // parseLog 里必须出现的关键词
  "notes": "为什么这么写"
}
```

**SVG 用精确值而不是下限**：多导出一张（把目录里的 `notes.txt` 也当成产物）
和少导出一张（目录没扫）都是真 bug，写下限会把前者放过去。

组件/网络用下限：KiCad 版本之间对「算不算一个网络」偶有差异，卡死精确值
会让 fixture 变成版本探测器而不是回归测试。

没写的字段一律不断言。缺库、缺 PCB 这类 fixture 就是靠把对应字段写成
`false` 或 `0` 来表达预期的。

## 四个 fixture 各自验证什么

| fixture | 验证点 |
| --- | --- |
| `simple-inverting-amp` | 基线：单页原理图 + PCB，netlist / ERC / DRC / 两种 SVG 全通 |
| `multi-sheet-demo` | 多页原理图必须保存**多个** SVG（早先按单文件读，遇到目录直接崩） |
| `pcb-only-demo` | 只有 `.kicad_pcb`：DRC 与 PCB SVG 应该有，netlist 应该没有，且不算失败 |
| `broken-missing-libs` | 缺符号库/封装库：必须降级并写清楚 parseLog，不能让项目挂掉 |

## 怎么造 fixture

1. 用 KiCad 新建工程，画到刚好够验证目标为止 —— 越小越好，仓库里不需要
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
