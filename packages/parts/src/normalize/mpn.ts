/**
 * MPN 归一化。
 *
 * 同一颗器件在 BOM 里可能写成 AD8605ARTZ-REEL7 / ad8605artz / AD 8605。
 * 归一化后的串是 Part 表的主键，也是 L1 精确匹配与幂等键的依据。
 */

/**
 * 大写、去掉分隔符。**不剥后缀** —— 剥后缀是 L2 的事，L1 必须是无损的
 * 精确匹配，否则 AD8605 与 AD8605ARTZ 会被当成同一颗，而它们的封装不同。
 */
export function normalizeMpn(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-_./]/g, '')
}

/** 常见的包装/温度/封装后缀，L2 前缀匹配时逐个剥 */
const SUFFIXES = [
  'REEL7', 'REEL', 'T7', 'TR', 'CT', 'DKR', 'EP',
  'RL', 'R7', 'R', 'T', 'G4', 'G3', 'E4', 'E1', 'NOPB', 'PBF',
]

/** 前缀最短留几位。再短就开始跨系列误伤（AD86 会撞上一堆无关型号）。 */
const MIN_PREFIX = 6

/**
 * 生成由长到短的候选前缀，供 L2 逐级尝试。
 *
 * AD8605ARTZ-REEL7 → [AD8605ARTZREEL7, AD8605ARTZ, AD8605ART, ..., AD8605]
 *
 * 由长到短是关键：先试最具体的，避免 AD8605 抢在 AD8605ARTZ 前面命中。
 *
 * 光剥尾字母不够。真实订货号里基础型号后面常跟数字：
 * `TPS7A0233PDBVR` 的基础型号是 `TPS7A02`，中间的 `33` 是输出电压代码 ——
 * 剥字母剥到 `TPS7A0233` 就停了，永远到不了 `TPS7A02`。所以在剥完已知后缀之后，
 * 再补一串到 MIN_PREFIX 为止的逐位截断。
 *
 * 代价是候选变多（一个 14 位的型号约 10 个候选），但查询走镜像的前缀索引，
 * 而且命中即停 —— 长的先试，短的通常轮不到。confidence 按前缀长度比例给分，
 * 越短越低，所以「勉强凑上的短前缀」不会被当成可靠匹配。
 */
export function mpnPrefixCandidates(raw: string): string[] {
  const norm = normalizeMpn(raw)
  const out = new Set<string>([norm])

  let base = norm
  for (const suf of SUFFIXES) {
    if (base.length > suf.length + 3 && base.endsWith(suf)) {
      base = base.slice(0, -suf.length)
      out.add(base)
    }
  }

  // 逐位截断到 MIN_PREFIX：数字段挡不住它，TPS7A0233 → TPS7A023 → TPS7A02
  for (let len = base.length - 1; len >= MIN_PREFIX; len--) {
    out.add(base.slice(0, len))
  }

  return [...out].sort((a, b) => b.length - a.length)
}

/** 两个 MPN 是否指向同一系列（用于误匹配自检） */
export function sharesFamily(a: string, b: string): boolean {
  const [x, y] = [normalizeMpn(a), normalizeMpn(b)]
  const shorter = x.length <= y.length ? x : y
  const longer = shorter === x ? y : x
  return shorter.length >= 5 && longer.startsWith(shorter)
}
