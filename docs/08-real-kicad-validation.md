# 08 · 真实 KiCad 工程验证

`packages/kicad` 至今只在两种输入上跑过：seed 里的 netlist，和测试里手写的
s-expression 片段。**真实 KiCad 导出的工程从没进过这条链路。**

这份文档说明怎么把它验掉。

---

## 1. 当前验证状态

| 项 | 状态 |
| --- | --- |
| netlist 解析（s-expression → Component/Net/Pin） | ✅ 单元测试覆盖，输入是手写 fixture |
| ERC/DRC JSON 归一化 | ✅ 单元测试覆盖，输入是手写 fixture |
| 安全解压（zip-slip / zip bomb / 符号链接） | ✅ 单元测试覆盖 |
| 全链路（zip → CLI → 产物 → 落库） | ⚠️ 用**假 CLI**覆盖，见下 |
| **真实 kicad-cli 的实际行为** | ❌ **未验证。没有任何 KiCad 版本被实机验证过** |

### 假 CLI 覆盖了什么、没覆盖什么

`packages/kicad/test/archive.test.ts` 用 `scripts/fixtures/fake-kicad-cli.mjs`
顶替 kicad-cli，在 CI 每次都跑。它验的是**我们这一侧**：

- 命令参数怎么拼、产物去哪找
- 多页原理图导出成目录时，每一页都要各自入库
- PCB 导出成单文件、或按层导出成目录，两种形态都要收上来
- ERC/DRC 以非零退出（有告警）不算解析失败
- 原理图相关命令全失败时降级，不清空已有设计数据
- parseLog 是可读的分步格式

它**验不了**真实 KiCad 的：子命令名与参数在各版本间是否一致、ERC/DRC JSON
的字段结构、SVG 输出到底是文件还是目录、大工程的耗时。这些只能靠下面的流程。

> 假 CLI 已经抓到过一个真 bug：`pcb export svg --output pcb-svg` 没写 `.svg`
> 后缀，KiCad 会产出一个无后缀文件，然后被 SVG 过滤器整个漏掉。

---

## 2. 安装 KiCad CLI

`kicad-cli` 随 KiCad 桌面版一起装，不单独发布。

| 平台 | 安装 | 可执行文件位置 |
| --- | --- | --- |
| macOS | `brew install --cask kicad` | `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli` |
| Ubuntu/Debian | `sudo add-apt-repository ppa:kicad/kicad-9.0-releases && sudo apt install kicad` | `/usr/bin/kicad-cli` |
| Windows | 官网安装包 | `C:\Program Files\KiCad\9.0\bin\kicad-cli.exe` |

macOS 上它不在 PATH 里，用环境变量指过去：

```bash
export KICAD_CLI="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
```

确认：

```bash
kicad-cli --version
```

---

## 3. 运行

```bash
pnpm test:kicad-real
```

- **没找到 kicad-cli** → 打印 `SKIPPED` 并退 0。CI 默认走这条，不会因此变红。
- **找到了** → 对 `examples/kicad-fixtures/` 下每个 fixture：把 `project/`
  打成 zip，走 `parseKicadArchive`（和线上上传完全同一条路径），再按
  `manifest.json` 的 `expect` 断言。

存储与数据库都是内存替身，不需要 Postgres，也不会碰到你本地的数据。

输出里有三种状态：

```
  ✓ simple-inverting-amp     mode=cli 5 组件 / 5 网络 / 3 违规 / 产物 6（sch-svg 2, pcb-svg 1）
  ✗ multi-sheet-demo         mode=cli ...
      · 原理图 SVG 1 < 2
  ○ pcb-only-demo            PLACEHOLDER  占位：只有 PCB 没有原理图
```

`PLACEHOLDER` 不算通过也不算失败，但会单独计数 —— 免得「0 失败」被读成
「已经验证过了」。

---

## 4. 已验证 / 未验证的 KiCad 版本

**目前这张表是空的。** 跑通之后请把结果填进来，包括失败的版本 —— 知道
哪个版本不行，和知道哪个版本行一样有用。

| KiCad 版本 | 平台 | 日期 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| _(待填)_ | | | | |

未验证（按预期风险从高到低）：

- **KiCad 6.x / 7.x**：`sch erc` / `pcb drc` 子命令是 7.0 才加的，6.x 大概率
  直接失败。失败也必须降级而不是崩 —— 这条本身就是要验的。
- **KiCad 8.x**：ERC/DRC 的 JSON 结构与 9.0 可能不同，`parseErcDrc` 的字段
  映射需要复核。
- **KiCad 9.x**：主要目标版本，但一次都没跑过。

---

## 5. 常见失败原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SKIPPED 未找到 kicad-cli` | 不在 PATH（macOS 常见） | 设 `KICAD_CLI` 指到绝对路径 |
| `probe` 失败但 CLI 明明能跑 | 用的是 GUI 可执行文件不是 `kicad-cli` | 确认路径以 `kicad-cli` 结尾 |
| `netlist 失败` | 工程里有未解析的符号库引用 | 正常现象，`broken-missing-libs` 专门验这个 |
| `原理图 SVG 0 < 1` | 该版本 `--output` 语义与预期不同 | 看 parseLog 里 CLI 的原始输出，调 `collectSvgArtifacts` |
| `ERC 报告应为 true` 但 CLI 成功了 | 该版本不支持 `--format json` | 改用默认格式并扩展 `parseErcDrc` |
| 超时（默认 120s） | 大工程 + 慢机器 | `parseProject` 的 `timeoutMs` 可调 |
| 解析结果为 0 组件但没报错 | 走了降级分支，属预期行为 | 读 parseLog 定位是哪一步没出结果 |

parseLog 是排查的唯一入口，格式固定：

```
[OK ] fetch: 42 KB
[OK ] unzip: 7 个文件 / 118 KB
[OK ] locate: pro=✓ sch=✓ pcb=✓
[OK ] probe: 9.0.1
[OK ] erc: ok
[ERR] netlist: 失败：Command failed ...
```

---

## 6. 加一个新 fixture

1. 在 `examples/kicad-fixtures/` 下建目录，照着现有的写 `manifest.json` 与
   `README.md`。
2. 真实工程文件放进 `<fixture>/project/`。
3. 删掉 `-backups/`、`fp-info-cache`、`*.kicad_prl` 这些本地状态。
4. `manifest.json` 的 `status` 改成 `ready`，`expect` 按实际结果填。
5. `pnpm test:kicad-real` 跑通，把 KiCad 版本填进上面第 4 节的表。

`expect` 里没写的字段一律不断言 —— 「只有 PCB 的工程没有 netlist」是靠把
`netlist` 写成 `false` 来表达的，不是靠不写。

字段清单见 `examples/kicad-fixtures/README.md`。

---

## 7. 为什么不把它放进 CI

CI 装一次 KiCad 要拉几百 MB，每个 PR 都装一遍不值当，而且解析行为跟
KiCad 版本强相关 —— CI 里装的那个版本通过了，也不代表工程师本机那个版本
通过。这条链路更适合在**要升级 KiCad 版本时**、或**改动
`packages/kicad` 时**由人手动跑一次，然后把结果记进第 4 节的表。

CI 里跑的是假 CLI 那层（`pnpm test` 的一部分），它保证我们这侧的逻辑不退化。
