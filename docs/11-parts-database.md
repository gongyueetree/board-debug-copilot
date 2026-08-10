# 11 · 器件库接入（ezPLM）

`packages/parts` 只做一件事：把一个我们不控制的外部器件库，收敛成内部稳定的
`NormalizedPart`。远端字段长什么样、分页怎么翻、鉴权怎么做，全部只影响
`providers/ezplm*.ts` 与 `mapping/` 三个文件 —— 与 `packages/ai` 里
「SDK import 只允许出现在 `providers/`」是同一条纪律。

## 0. 先说清楚它是什么

**ezPLM 的系统库不是「110 万条通用器件库」。** 手册原文：

> 数据范围：仅返回当前白名单内的供应商物料与其参考设计

对我们的直接影响：

| 方案原本的假设 | ezPLM 的实际情况 |
| --- | --- |
| 110 万条通用器件 | 白名单供应商的系统库，范围由白名单决定 |
| 有 MPN 精确查端点 | **没有**，只有关键词模糊搜，精确匹配靠我们自己筛 |
| 有批量查端点 | **没有**，只能逐个查 |
| 有替代料端点 | **没有**，`findAlternates` 必须走本地兜底 |
| 有类目树 | **没有**，返回字段里根本没有 `category` |
| 有参数化检索 | **没有** |
| 按 QPS 限流 | 按**天**计配额，超了 429 |
| — | **多出一个能力：参考设计**（方案里没算到） |

匹配率因此取决于「用户 BOM 里的器件在不在白名单供应商里」，而不是「库有多大」。
P9 验收线（L1+L2 ≥ 70%）要按这个前提重新看 —— 见 §10。

---

## 1. 当前状态

| 项 | 状态 |
| --- | --- |
| 内部模型与归一化（MPN / 单位 / 封装 / 类目） | ✅ 单元测试覆盖 |
| 四层匹配管线 + 置信阈值 | ✅ 单元测试覆盖 |
| 三级缓存（LRU / 镜像 / 远端） | ✅ 单元测试覆盖 |
| mock provider（内置常识参数） | ✅ 全链路可跑 |
| `/health` 的 `parts` 段 | ✅ 与 `llm` / `storage` 同构 |
| 回填脚本与分层统计 | ✅ `pnpm parts:backfill --dry-run` |
| ezPLM 签名算法 | ✅ 对着厂商 demo 生成的 golden vector 逐条比对 |
| ezPLM provider（分页 / 错误映射 / 精确筛选） | ✅ 对进程内假服务，服务端独立验签 |
| **ezPLM 真实接口** | ⬜ **NOT RUN** — 没有 API Key，见 §9 |

mock provider 下对内置 Demo 跑回填的结果（174 个组件，含三个项目）：

```
  L1    MPN 精确         0    0.0%
  L2    型号前缀        24   13.8%
  L3    参数化           0    0.0%
  L4    向量语义         0    0.0%
  —     未匹配         150   86.2%
```

**13.8% 是内置库只有 5 颗器件的必然结果，不是管线有问题。** L1 为 0 也正常：
seed 用的是真实订货号（`AD8605ARZ` / `TPS7A0233PDBVR`），基础型号要靠 L2 剥出来。
≥ 70% 的验收线是给 `PARTS_PROVIDER=remote` 的。

---

## 2. 接口契约

### 鉴权（手册 §1.1）

四个头缺一不可：

```
X-API-Key     API Key 本身，同时是 HMAC 密钥
X-Timestamp   Unix 秒级
X-Nonce       一次性随机串（服务端查重，复用即 401）
X-Signature   base64url(HMAC-SHA256(APIKey, canonical))，无 padding
```

canonical 拼接顺序：

```
METHOD \n PATH \n 排序后的 query \n X-Timestamp \n X-Nonce
```

三个容易错、错了只会得到 401 且没有别的线索的点：

1. **query 排序用字节序，不是 `localeCompare`。** 官方 JS demo 用的是
   `localeCompare`，它把 `a` 排在 `A` 前面；PHP 的 `strcmp` 与 Python 的元组排序
   把 `A` 排前面。三份 demo 里 **JS 是异类**，服务端（PHP/Python/Java 任一）
   都是字节序。现有参数全是小写开头所以今天看不出差别，但加一个大写开头的
   参数那天就会 401。
2. **空值参数要剔除。** `cursor=''` 既不参与签名，也不能出现在 URL 里。
3. **签名用的 query 串和实际 URL 的 query 串必须是同一份。** 分别构造是这类
   签名最常见的翻车点：本地怎么看都对，服务端就是 401。

`packages/parts/test/ezplm-signing.test.ts` 拿厂商 demo 算出的 golden vector
逐条比对，**没有 API Key 也能验证签名写对了**。

### 两个端点

| 端点 | 参数 | 说明 |
| --- | --- | --- |
| `GET /api/v1/api-key/parts` | `keyword?` `cursor?` `pageSize?` | 关键词模糊搜，返回 `data + meta` |
| `GET /api/v1/api-key/reference-designs` | `partlibId`(必填) `cursor?` `pageSize?` | 按物料 id 查参考设计 |

调用顺序固定：先查物料拿 `id`，再拿这个 `id` 当 `partlibId` 查参考设计。

### 字段

手册 §2 只列了「最重要的字段」，**没有完整字段字典，也没有响应样例**：

```
id            后续查参考设计要用
mpn           物料型号
manufacturer  供应商名称
footprint / symbol / pdf / attributes    详细物料信息
```

参考设计侧：`name` / `link` / `image`（可能为空）/ `description`。

### 错误码（手册 §5）

| 状态 | 含义 | 我们的处理 |
| --- | --- | --- |
| 400 | 漏传签名头或参数格式错 | `BAD_RESPONSE`，不重试 |
| 401 | 签名不正确，或 nonce 被复用 | `UNAUTHORIZED`，不重试 |
| 404 | `partlibId` 不正确 | `BAD_RESPONSE`，不重试 |
| 429 | **当天**调用次数已达上限 | `RATE_LIMITED`，**retryable=false** |

429 标成不可重试是有意的：配额按天算，立刻退避重试只会白白再消耗一次额度，
要等到次日或找管理员重置。

## 3. 仍然缺的东西

`providers/remote.ts` 的 `MISSING_SPEC`。**这几项不阻塞接入，但会限制能力**，
所以在 `/health` 的 `parts.missingSpec` 里显形，而不是等匹配率上不去时才猜原因。

判据：**缺了会让我们编数据的，阻塞接入；缺了只是少一项能力的，不阻塞。**

| 项 | 影响 | 怎么补 |
| --- | --- | --- |
| 完整字段字典 | 只有七个字段名，没有类型/单位/可空性 | 跑 `pnpm test:parts-real` 打印真实结构 |
| **真实响应样例** | `attributes` 的内部结构是盲的，**参数抽取率无法预估** | 同上 |
| `meta` 的字段名 | 翻页游标叫什么不知道 | 同上；认不出游标就停止翻页而不是死循环 |
| 具体配额数字 | 不知道每天多少次，无法规划回填批量 | 问管理员 |
| 类目字典 | ezPLM 不返回 `category` | 见 §7，只能推断 |

`attributes` 那一条是最关键的：**参数抽取是 P9 → P10 全部价值的所在**，
而它现在是盲的。`flattenParams` 同时支持 `{k:v}` 与 `[{name,value}]` 两种形状，
两种都不匹配时参数为空、`__meta.complete=false` 会如实反映 —— 但那意味着
P10 拿不到任何真实参数。

---

## 4. 环境变量

```bash
PARTS_PROVIDER=mock|remote        # 默认 mock
PARTS_API_KEY=                    # 唯一必填项，仅服务端，禁止出现在 apps/web
PARTS_API_BASE_URL=               # 留空即 https://www.ezplm.cn
PARTS_PAGE_SIZE=50                # 单页条数
PARTS_TIMEOUT_MS=15000
PARTS_CACHE_TTL_DAYS=7
PARTS_EMBED_ON_MIRROR=true
```

`PARTS_BATCH_SIZE` / `PARTS_MAX_CONCURRENCY` 对 ezPLM **不生效**：它没有批量
端点，且配额按天计而不是按 QPS —— 并发只会更快烧完当天额度，拿不到更多数据。
两个变量留着是为了将来接别的库。

`MOCK_MODE=true` 时即使 `PARTS_PROVIDER=remote` 也强制走 mock，且不发起任何
真实请求（CLAUDE.md 硬性原则 #2，也是 CI 不消耗真实配额的前提）。

---

## 5. 降级链

```
远端 API ──失败──> Postgres 镜像（即使过期）──没有──> mock 内置常识参数
                                                        └─> 标 degraded
```

`GET /health`：

```json
"parts": {
  "provider": "remote",
  "degraded": true,
  "mirrorHit": 0.83,
  "lastError": null,
  "latencyP95Ms": 240,
  "missingSpec": ["fields: 完整字段字典 ...", "samples: 真实响应样例 ...", "..."]
}
```

与 `llm.degraded` / `storage.degraded` 形状一致 —— 运维不该为了看两种降级去读
两种不同的结构。

**`degraded` 与 `missingSpec` 是两件事，不混成一个布尔**：接口在正常工作时
`degraded=false`，但 `missingSpec` 仍非空（还缺字段字典与样例）。
如果因为「信息不全」就一直报降级，真降级的时候就没人看了。

**器件库降级不影响 `/health` 的 `status`**（会退到内置常识参数，服务照常可用），
但必须报出来：参数不准会安静地降低 AI 输出质量，没有别的信号。

---

## 6. 三级缓存

| 层 | 容量 / TTL | 挡什么 |
| --- | --- | --- |
| 进程内 LRU | 2000 / 60s | 同一次解析里的重复查询（一块板 24 颗 10k 电阻查 24 次同一个 MPN） |
| Postgres `Part` 镜像 | TTL 7 天 | 跨请求、跨进程复用；**过期后先返回旧值再异步刷新** |
| 远端 API | — | 前两层都没有时 |

过期先返回旧值是有意的：器件参数一周不变是常态，为了拿最新的 1% 差异让 BOM 页
多等两秒不划算。刷新失败不影响本次返回，只是下次还会再试。

**只镜像「项目真正用到的」+ 预热脚本拉的高频器件。110 万条不全量导入** ——
没必要也难维护，全量之后 TTL 刷新会变成一个独立的运维负担。

---

## 7. 四层匹配

| 层 | 方法 | confidence | 典型对象 |
| --- | --- | --- | --- |
| L1 | MPN 精确（归一化后） | 0.95–1.0 | BOM 里写了准确型号 |
| L2 | 型号前缀 | 0.75–0.94 | `AD8605ARZ` → `AD8605` |
| L3 | 参数化（类目 + 值 + 封装） | 0.55–0.80 | 阻容感，无 MPN |
| L4 | 向量语义 | 0.30–0.60 | 兜底，**永不自动采纳** |

`confidence < 0.6` 一律 `accepted = false` + `matchStatus = NEEDS_REVIEW`。

L2 的前缀候选由长到短，先试最具体的。**逐位截断到 6 位**而不是只剥尾字母 ——
真实订货号里基础型号后面常跟数字（`TPS7A0233PDBVR` 的基础型号是 `TPS7A02`，
中间的 `33` 是输出电压代码），只剥字母会停在 `TPS7A0233`，永远到不了。

---

## 8. 参数抽取

按类目白名单抽（见 `normalize/params.ts` 的 `PARAM_WHITELIST`）。抽不到写进
`__meta.missing`：

```jsonc
"paramsJson": {
  "vsMin": { "value": 2.7, "unit": "V", "raw": "2.7 V" },
  "vsMax": { "value": 5.5, "unit": "V", "raw": "5.5 V" },
  "__meta": { "complete": false, "missing": ["vsAbsMax", "gbw"], "parser": "mock@v1" }
}
```

`complete: false` 时 DesignDigest 把该器件降级为 `params-unknown`（P10 实现），
让 LLM 在 evidence 里写「缺 XX 参数」而不是编一个。

**认不出的类目落 `OTHER`，而 `OTHER` 的白名单是空的** —— 这是有意的失败方式：
认不出就不抽参数，而不是抽错参数。

参数完整率按类目统计，`pnpm parts:backfill` 会打印。**这个数字决定 P10 的实际收益。**

---

## 9. 真实接口联调（NOT RUN）

```bash
PARTS_PROVIDER=remote PARTS_API_KEY=<key> pnpm test:parts-real
```

没配 `PARTS_API_KEY` 就 `SKIPPED` 并退 0。CI 不跑它 —— **ezPLM 的配额按天算**，
每跑一次 CI 就少一天的额度。

脚本只发 4~5 个请求，把三件事一次问清楚：

1. 签名对不对（真实服务端验签，本地 golden vector 验不了这一步）
2. **真实响应的字段结构长什么样** —— 逐字段打印类型与预览
3. `attributes` 是 `{k:v}` 还是 `[{name,value}]`，参数能抽出几项

第 2、3 项是跑它的主要目的。手册没给样例，这是唯一能看清 `attributes` 的办法，
而参数抽取是 P9 → P10 全部价值的所在。

### 跑完之后

把打印出来的字段结构填进 §2「字段」一节，据此调整
`mapping/field-map.ts` 的 `FIELD_PATHS`，然后：

```bash
PARTS_PROVIDER=remote PARTS_API_KEY=<key> pnpm parts:backfill --dry-run
```

看分层匹配率与参数完整率，填进 §1 的状态表。

### 记录表

| 项 | 值 |
| --- | --- |
| 日期 | — |
| API Key 来源 | — |
| 白名单供应商范围 | — |
| 签名是否一次通过 | — |
| `attributes` 结构 | — |
| 参数完整率（按类目） | — |
| L1+L2 匹配率 | — |
| 每日配额 | — |

**这张表空着就是没验过。**

---

---

## 10. 脚本

```bash
# 回填：遍历存量 Component 跑匹配管线，输出分层匹配率
pnpm parts:backfill --dry-run
pnpm parts:backfill --project <id>
PARTS_PROVIDER=remote pnpm parts:backfill

# 预热：给向量检索准备底料
pnpm parts:warm --category opamp,ldo,dac --top 500
```

没有预热的话 `PartKnowledge` 是空的，`searchPartsDatabase` 工具永远返回零条 ——
接了 110 万条也跟没接一样。

---

## 11. 迁移注意

`PartKnowledge.embedding` 上的 HNSW 索引由原始 SQL 创建，Prisma 表达不了向量索引，
所以 **`prisma migrate diff` 每次都会生成 `DROP INDEX PartKnowledge_embedding_idx`**。

P9 的迁移文件里这句已经手工删掉了。删掉它的后果是**向量检索退化成全表扫描，
而且不报错，只是变慢** —— 这种失败没有任何信号。

`packages/db/test/migrations.test.ts` 会扫所有迁移文件挡住这件事，
往迁移里加一句 `DROP INDEX ... PartKnowledge_embedding_idx` 立刻测试变红。


---

---

## 12. P9 验收线要重新看

方案定的是 L1+L2 ≥ 70%。那是按「110 万条通用库」估的。

ezPLM 是白名单供应商的系统库，匹配率取决于**用户 BOM 里的器件在不在白名单里**，
而不是库有多大。所以：

- 先跑一次 `pnpm parts:backfill --dry-run` 拿到真实数字
- 如果远低于 70%，先确认是「白名单覆盖不到」还是「我们的匹配管线有问题」——
  前者调整不了，后者才该改代码
- 区分方法：看未匹配的那些器件，手工在 ezPLM 上搜一下。搜得到说明是管线问题，
  搜不到说明是白名单范围问题

**在拿到真实数字之前，不要调阈值去凑那个 70%。**
