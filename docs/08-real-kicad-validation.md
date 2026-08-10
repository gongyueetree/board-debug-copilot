# 08 · 真实 KiCad 工程验证

**2026-08-09 起，这条链路已在 kicad-cli 10.0.1（macOS）上跑通 4/4 fixture。**
更早的版本（6.x / 7.x / 8.x / 9.x）仍未验证。

这份文档说明怎么复现、怎么加 fixture、以及验的时候踩到了什么。

---

## 1. 当前验证状态

| 项 | 状态 |
| --- | --- |
| netlist 解析（s-expression → Component/Net/Pin） | ✅ 单元测试覆盖，输入是手写 fixture |
| ERC/DRC JSON 归一化 | ✅ 单元测试覆盖，输入是手写 fixture |
| 安全解压（zip-slip / zip bomb / 符号链接） | ✅ 单元测试覆盖 |
| 全链路（zip → CLI → 产物 → 落库） | ✅ CI 每次跑（假 CLI）+ 真实 kicad-cli 10.0.1 跑通 4/4 |
| **真实 kicad-cli 10.0.1** | ✅ **VERIFIED**（macOS，2026-08-09，见 §4） |
| **kicad-cli 6.x / 7.x / 8.x / 9.x** | ❌ **NOT RUN** |
| **Linux / Windows 上的 kicad-cli** | ❌ **NOT RUN**（只在 macOS 上验过） |

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

> 假 CLI 抓到过一个真 bug：`pcb export svg --output pcb-svg` 没写 `.svg` 后缀，
> KiCad 会产出一个无后缀文件，然后被 SVG 过滤器整个漏掉。
>
> 真实 CLI 又抓到两个假 CLI 抓不到的（见 §4）—— 这就是为什么两层都要有。

---

## 2. 安装 KiCad CLI

`kicad-cli` 随 KiCad 桌面版一起装，不单独发布。

| 平台 | 安装 | 可执行文件位置 |
| --- | --- | --- |
| macOS | `brew install --cask kicad` | `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli` |
| Ubuntu/Debian | `sudo add-apt-repository ppa:kicad/kicad-releases && sudo apt install kicad` | `/usr/bin/kicad-cli` |
| Windows | 官网安装包 | `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe` |

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
  `manifest.json` 里的期望值断言。

存储与数据库都是内存替身，不需要 Postgres，也不会碰到你本地的数据。

输出里有三种状态：

```
  ✓ simple-inverting-amp     mode=cli 6 组件 / 6 网络 / 29 违规 / 产物 4（sch-svg 1, pcb-svg 1）
  ✗ multi-sheet-demo         mode=cli ...
      · 原理图 SVG 1，期望 3
  ○ some-new-fixture         PLACEHOLDER  占位：project/ 里还没有工程文件
```

`PLACEHOLDER` 不算通过也不算失败，但会单独计数 —— 免得「0 失败」被读成
「已经验证过了」。目前四个 fixture 都不是占位。

---

## 4. 验证记录

### VERIFIED：kicad-cli 10.0.1 / macOS / 2026-08-09

```
$ export KICAD_CLI="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
$ pnpm test:kicad-real

真实 KiCad 工程解析验证
  kicad-cli: 10.0.1

  ✓ broken-missing-libs      mode=cli 1 组件 / 3 网络 / 19 违规 / 产物 3（sch-svg 1, pcb-svg 0）
  ✓ multi-sheet-demo         mode=cli 8 组件 / 8 网络 / 43 违规 / 产物 6（sch-svg 3, pcb-svg 1）
  ✓ pcb-only-demo            mode=mock 0 组件 / 0 网络 / 0 违规 / 产物 1（sch-svg 0, pcb-svg 1）
  ✓ simple-inverting-amp     mode=cli 6 组件 / 6 网络 / 29 违规 / 产物 4（sch-svg 1, pcb-svg 1）

4/4 个可运行 fixture 通过
```

| KiCad 版本 | 平台 | 日期 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 10.0.1 | macOS 26 (arm64) | 2026-08-09 | ✅ VERIFIED 4/4 | `pcb drc` 挂死，见 §6 |
| 9.x | — | — | ❌ NOT RUN | |
| 8.x | — | — | ❌ NOT RUN | ERC/DRC 的 JSON 结构可能不同，`parseErcDrc` 需复核 |
| 7.x | — | — | ❌ NOT RUN | |
| 6.x | — | — | ❌ NOT RUN | `sch erc` / `pcb drc` 是 7.0 才加的，预期直接失败（但必须降级不崩） |
| 10.x on Linux | — | — | ❌ NOT RUN | |
| 10.x on Windows | — | — | ❌ NOT RUN | |

### 真实 CLI 抓到的 bug（假 CLI 抓不到的）

1. **`pcb export svg` 不给 `--layers` 会直接退出。**
   KiCad 9 起 `--layers` 是必填，不给就是
   `At least one layer must be specified`，**一张 PCB SVG 都不产**，而且
   我们把它当成软失败继续走，所以从来没人发现。
   修法：默认传 `F.Cu,B.Cu,F.SilkS,F.Mask,Edge.Cuts`，可用
   `KICAD_PCB_SVG_LAYERS` 覆盖。假 CLI 现在也照着真 CLI 的行为拒绝无 `--layers` 的调用。

2. **层次化工程挑错了根图。**
   压缩包里有 3 个 `.kicad_sch`，`files.find()` 拿到的是字母序最前的
   `amp.kicad_sch`（一个子图）。结果是 netlist 只有子图那 3 个器件、
   SVG 只有 1 页 —— **而且不报错**，只是安静地少一半数据。
   修法：`pickRoot()` 按 `.kicad_pro` 同名挑根图，没有 pro 时退回层级最浅的。

两个都只有在真实多页工程 + 真实 CLI 下才会暴露。

---

## 5. 常见失败原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SKIPPED 未找到 kicad-cli` | 不在 PATH（macOS 常见） | 设 `KICAD_CLI` 指到绝对路径 |
| `probe` 失败但 CLI 明明能跑 | 用的是 GUI 可执行文件不是 `kicad-cli` | 确认路径以 `kicad-cli` 结尾 |
| `netlist 失败` | 工程里有未解析的符号库引用 | 正常现象，`broken-missing-libs` 专门验这个 |
| `PCB SVG 0，期望 1` | 该版本 `--layers` 的层名不认 | 用 `KICAD_PCB_SVG_LAYERS` 换一组层名 |
| `原理图 SVG N，期望 M` | 该版本 `--output` 语义与预期不同 | 看 parseLog 里 CLI 的原始输出，调 `collectSvgArtifacts` |
| 组件数远少于预期 | 层次化工程挑错了根图 | 确认 `.kicad_pro` 与根 `.kicad_sch` 同名（`pickRoot` 靠这个判定） |
| `ERC 报告应为 true` 但 CLI 成功了 | 该版本不支持 `--format json` | 改用默认格式并扩展 `parseErcDrc` |
| `drc: 超时 60000ms 被终止` | KiCad 10 的已知挂死，见 §6 | 预期行为，`expectDrc: false` |
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

## 6. 已知问题：KiCad 10.0.1 的 `pcb drc` 会挂死

在 macOS + kicad-cli 10.0.1 上，`kicad-cli pcb drc` **永远不返回**：

```bash
# 一块只有板框、没有任何封装的空板，同样挂住
kicad-cli pcb drc --format json --output drc.json empty.kicad_pcb   # 5 分钟无输出
```

已排除的因素：与板子内容无关（空板也挂）、与 `--format` 无关（json 和
report 都挂）、与 stdin 无关（`</dev/null` 也挂）。同一块板的
`pcb export svg` 与 `sch erc` 都正常，所以不是 CLI 整体坏了。

### 我们这边怎么处理

DRC 单独一个超时预算，默认 60s（其余步骤仍是 120s）：

```bash
KICAD_DRC_TIMEOUT_MS=60000   # 默认值；真实大板的 DRC 可能要更久，按需调大
```

超时会在 parseLog 里写成可区分的一行，不会被误读成「板子有问题」：

```
[OK ] drc: 超时 60000ms 被终止（KiCad 10 的 pcb drc 有挂死问题，见 docs/08 §6）
```

DRC 失败不影响 netlist、ERC 与 SVG，所以解析整体仍是 READY。四个 fixture 的
`expectDrc` 都是 `false`，记的就是这件事 —— 换到一个 DRC 正常的 KiCad 版本后
应该改回 `true`。

**没有验证过其它平台/版本是否同样挂死。** 如果你的环境上 DRC 正常，请把版本
与平台补进 §4 的表。

---

## 7. 加一个新 fixture

1. 在 `examples/kicad-fixtures/` 下建目录，照着现有的写 `manifest.json` 与
   `README.md`。
2. 真实工程文件放进 `<fixture>/project/`。
3. 删掉 `-backups/`、`fp-info-cache`、`*.kicad_prl` 这些本地状态。
4. `manifest.json` 的 `status` 改成 `ready`，各 `expected*` 按实际结果填。
5. `pnpm test:kicad-real` 跑通，把 KiCad 版本填进上面第 4 节的表。

没写的字段一律不断言 —— 「只有 PCB 的工程没有 netlist」是靠把 `expectNetlist`
写成 `false` 来表达的，不是靠不写。SVG 张数用精确值，组件/网络用下限。

字段清单见 `examples/kicad-fixtures/README.md`。

---

## 8. 为什么不把它放进 CI

CI 装一次 KiCad 要拉几百 MB，每个 PR 都装一遍不值当，而且解析行为跟
KiCad 版本强相关 —— CI 里装的那个版本通过了，也不代表工程师本机那个版本
通过。这条链路更适合在**要升级 KiCad 版本时**、或**改动
`packages/kicad` 时**由人手动跑一次，然后把结果记进第 4 节的表。

CI 里跑的是假 CLI 那层（`pnpm test` 的一部分），它保证我们这侧的逻辑不退化。


---
