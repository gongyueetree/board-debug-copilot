import { describe, expect, it } from 'vitest'
import {
  AUTO_ACCEPT_THRESHOLD,
  LruCache,
  PARAM_WHITELIST,
  PartsService,
  chunk,
  createPartsProvider,
  extractParams,
  guessCategoryFromRef,
  mapCategory,
  mapWithConcurrency,
  mpnPrefixCandidates,
  normalizeMpn,
  normalizePackage,
  paramCompleteness,
  parseQuantity,
} from '../src'

describe('MPN 归一化', () => {
  it('大写并去掉分隔符', () => {
    expect(normalizeMpn(' ad8605artz-reel7 ')).toBe('AD8605ARTZREEL7')
    expect(normalizeMpn('TPS7A02_DBV')).toBe('TPS7A02DBV')
    expect(normalizeMpn('MCP4725A0T-E/CH')).toBe('MCP4725A0TECH')
  })

  it('L1 必须无损：不剥后缀', () => {
    // 剥了的话 AD8605 与 AD8605ARTZ 会被当成同一颗，而它们封装不同
    expect(normalizeMpn('AD8605ARTZ')).not.toBe(normalizeMpn('AD8605'))
  })

  it('前缀候选由长到短，先试最具体的', () => {
    const c = mpnPrefixCandidates('AD8605ARTZ-REEL7')
    expect(c[0]).toBe('AD8605ARTZREEL7')
    expect(c).toContain('AD8605')
    for (let i = 1; i < c.length; i++) {
      expect(c[i]!.length).toBeLessThanOrEqual(c[i - 1]!.length)
    }
  })

  it('短型号不会被剥到面目全非', () => {
    // 再短就开始跨系列误伤：AD86 会撞上一堆无关型号
    expect(mpnPrefixCandidates('LM358').every((c) => c.length >= 5)).toBe(true)
    expect(mpnPrefixCandidates('TPS7A0233PDBVR').every((c) => c.length >= 6)).toBe(true)
  })

  it('数字段挡不住截断：真实订货号能落到基础型号', () => {
    // TPS7A0233PDBVR 的基础型号是 TPS7A02，中间的 33 是输出电压代码。
    // 只剥尾字母的话会停在 TPS7A0233，永远到不了 TPS7A02。
    expect(mpnPrefixCandidates('TPS7A0233PDBVR')).toContain('TPS7A02')
    expect(mpnPrefixCandidates('MCP4725A0T-E/CH')).toContain('MCP4725')
  })
})

describe('单位归一', () => {
  it.each([
    ['10k', 10000],
    ['10K', 10000],
    ['10kΩ', 10000],
    ['10 kohm', 10000],
    ['10000', 10000],
    ['100R', 100],
    ['4.7uF', 4.7e-6],
    ['0.1 µF', 1e-7],
    ['100nF', 1e-7],
  ])('%s → %s', (input, want) => {
    expect(parseQuantity(input)?.value).toBeCloseTo(want, 12)
  })

  it('欧洲写法：字母当小数点', () => {
    expect(parseQuantity('2k2')?.value).toBe(2200)
    expect(parseQuantity('4R7')?.value).toBeCloseTo(4.7, 10)
    expect(parseQuantity('1M5')?.value).toBe(1.5e6)
  })

  it('解析不了返回 null，不瞎猜', () => {
    // 猜错的电容值会让 L3 匹配到一颗完全不同的器件，下游看不出来
    expect(parseQuantity('DNP')).toBeNull()
    expect(parseQuantity('')).toBeNull()
    expect(parseQuantity('见说明')).toBeNull()
  })

  it('封装归一', () => {
    expect(normalizePackage('Resistor_SMD:R_0603_1608Metric')).toBe('0603')
    expect(normalizePackage('Package_SO:SOIC-8')).toBe('SOIC-8')
    // 引脚数不能丢：SOT-23-5 与 SOT-23-6 是两种封装
    expect(normalizePackage('SOT23-6')).toBe('SOT-23-6')
    expect(normalizePackage('SOT-23-5')).toBe('SOT-23-5')
    expect(normalizePackage('Package_TO_SOT_SMD:SOT-23-6')).toBe('SOT-23-6')
    expect(normalizePackage('TSSOP-20')).toBe('TSSOP-20')
    expect(normalizePackage(null)).toBeUndefined()
  })
})

describe('类目映射', () => {
  it('中文与英文都认', () => {
    expect(mapCategory('运算放大器')).toBe('OPAMP')
    expect(mapCategory('Operational Amplifier')).toBe('OPAMP')
    expect(mapCategory('LDO 稳压器')).toBe('LDO')
    expect(mapCategory('贴片电容')).toBe('CAPACITOR')
  })

  it('认不出落 OTHER，而 OTHER 的白名单是空的', () => {
    // 这是有意的失败方式：认不出就不抽参数，而不是抽错参数
    expect(mapCategory('某种没见过的类目')).toBe('OTHER')
    expect(PARAM_WHITELIST.OTHER).toEqual([])
  })

  it('位号首字母能猜出无源器件，但 U 开头一律 OTHER', () => {
    expect(guessCategoryFromRef('R12')).toBe('RESISTOR')
    expect(guessCategoryFromRef('C3')).toBe('CAPACITOR')
    // U 什么都可能是，猜成 OPAMP 会让参数抽取走错白名单
    expect(guessCategoryFromRef('U1')).toBe('OTHER')
  })
})

describe('参数抽取', () => {
  it('按类目白名单抽，抽全了 complete=true', () => {
    const bag = extractParams('RESISTOR', {
      resistance: '10k',
      tolerance: '1%',
      powerW: '0.1W',
      tempco: '100ppm',
      price: 0.01, // 不在白名单里，不该出现
    })
    expect(bag.resistance?.value).toBe(10000)
    expect(bag.price).toBeUndefined()
    expect(bag.__meta?.complete).toBe(true)
    expect(bag.__meta?.missing).toEqual([])
  })

  it('抽不到的写进 missing，不留空', () => {
    const bag = extractParams('OPAMP', { vsMin: '2.7V', vsMax: '5.5V' })
    expect(bag.__meta?.complete).toBe(false)
    expect(bag.__meta?.missing).toContain('vsAbsMax')
    expect(bag.__meta?.missing).toContain('gbw')
  })

  it('区间串拆成 min/max', () => {
    const bag = extractParams('OPAMP', { supplyRange: '2.7~5.5 V' })
    expect(bag.vsMin?.value).toBe(2.7)
    expect(bag.vsMax?.value).toBe(5.5)
  })

  it('别名归一：supplyVoltageMin 等价 vsMin', () => {
    expect(extractParams('OPAMP', { supplyVoltageMin: '2.7V' }).vsMin?.value).toBe(2.7)
    expect(extractParams('OPAMP', { 'gain-bandwidth': '10MHz' }).gbw?.value).toBe(1e7)
  })

  it('完整率可统计 —— 这个数字决定 P10 的实际收益', () => {
    const bag = extractParams('OPAMP', { vsMin: '2.7V', vsMax: '5.5V', vsAbsMax: '6V' })
    expect(paramCompleteness('OPAMP', bag)).toEqual({ got: 3, want: 9 })
  })
})

describe('provider factory 与降级', () => {
  it('默认 mock，不降级', () => {
    const info = createPartsProvider({} as NodeJS.ProcessEnv)
    expect(info.provider.name).toBe('mock')
    expect(info.degraded).toBe(false)
  })

  it('MOCK_MODE=true 时不许走远端', () => {
    // 硬性原则 #2：MOCK_MODE 下禁止发起任何真实请求
    const info = createPartsProvider({
      MOCK_MODE: 'true',
      PARTS_PROVIDER: 'remote',
      PARTS_API_BASE_URL: 'https://example.com',
      PARTS_API_KEY: 'k',
    } as NodeJS.ProcessEnv)
    expect(info.provider.name).toBe('mock')
    expect(info.degraded).toBe(true)
    expect(info.reason).toMatch(/MOCK_MODE/)
  })

  it('要 remote 但没给 key 时降级并说明原因', () => {
    // base URL 有默认值（手册写死了 www.ezplm.cn），所以只有 key 是必填
    const info = createPartsProvider({ PARTS_PROVIDER: 'remote' } as NodeJS.ProcessEnv)
    expect(info.provider.name).toBe('mock')
    expect(info.degraded).toBe(true)
    expect(info.reason).toMatch(/PARTS_API_KEY/)
  })

  it('给了 key 就能用，但仍列出缺的接入信息', () => {
    // 「能用」和「接入信息完整」是两件事，不该混成一个布尔：
    // degraded=false（它确实在工作），missingSpec 非空（还缺字段字典与样例）
    const info = createPartsProvider({
      PARTS_PROVIDER: 'remote',
      PARTS_API_KEY: 'k',
    } as NodeJS.ProcessEnv)
    expect(info.provider.name).toBe('remote')
    expect(info.degraded).toBe(false)
    expect(info.missingSpec.length).toBeGreaterThan(0)
    expect(info.missingSpec.join(' ')).toMatch(/samples|fields/)
  })

  it('不配 base URL 也能用：手册写死了 ezplm.cn', () => {
    const info = createPartsProvider({
      PARTS_PROVIDER: 'remote',
      PARTS_API_KEY: 'k',
    } as NodeJS.ProcessEnv)
    expect(info.provider.name).toBe('remote')
  })
})

describe('四层匹配', () => {
  const svc = () => new PartsService({ env: {} as NodeJS.ProcessEnv })

  it('L1 MPN 精确命中，confidence ≥ 0.95', async () => {
    const r = await svc().matchComponent({ ref: 'U1', partNumber: 'AD8605' })
    expect(r.method).toBe('EXACT')
    expect(r.confidence).toBeGreaterThanOrEqual(0.95)
    expect(r.status).toBe('MATCHED')
    expect(r.part?.mpn).toBe('AD8605')
  })

  it('L1 命中但制造商对不上时压低 confidence 并写进 reason', async () => {
    const r = await svc().matchComponent({
      ref: 'U1',
      partNumber: 'AD8605',
      manufacturer: 'SomeOtherCorp',
    })
    expect(r.confidence).toBeLessThan(1.0)
    expect(r.reason).toMatch(/制造商不一致/)
  })

  it('L2 前缀：带包装后缀的型号能落到基础型号', async () => {
    const r = await svc().matchComponent({ ref: 'U1', partNumber: 'AD8605ARTZ-REEL7' })
    expect(r.method).toBe('PREFIX')
    expect(r.part?.mpn).toBe('AD8605')
    expect(r.confidence).toBeGreaterThanOrEqual(0.75)
    expect(r.confidence).toBeLessThanOrEqual(0.94)
  })

  it('查不到就是查不到，不编一个', async () => {
    const r = await svc().matchComponent({ ref: 'U9', partNumber: 'NO_SUCH_PART_12345' })
    expect(r.status).toBe('UNMATCHED')
    expect(r.part).toBeNull()
    expect(r.confidence).toBe(0)
  })

  it('无型号信息的组件不参与 L1/L2', async () => {
    const r = await svc().matchComponent({ ref: 'TP1' })
    expect(r.status).toBe('UNMATCHED')
    expect(r.reason).toMatch(/无型号信息/)
  })

  it('低于阈值一律 NEEDS_REVIEW —— 自动采纳低置信匹配是典型翻车方式', () => {
    expect(AUTO_ACCEPT_THRESHOLD).toBe(0.6)
  })
})

describe('批量分片与并发', () => {
  it('分片按大小切，最后一片可以不满', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 50)).toEqual([])
  })

  it('并发不超过上限，且结果保持输入顺序', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
  })
})

describe('LRU 缓存', () => {
  it('超容量时淘汰最久未用的', () => {
    const c = new LruCache<number>(2, 60_000)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a') // a 变成最近使用
    c.set('c', 3) // 淘汰 b
    expect(c.get('a')).toBe(1)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(3)
  })

  it('过期即失效', async () => {
    const c = new LruCache<number>(10, 10)
    c.set('a', 1)
    await new Promise((r) => setTimeout(r, 25))
    expect(c.get('a')).toBeUndefined()
  })
})

describe('健康状态', () => {
  it('mock 模式不降级，missingSpec 不出现', async () => {
    const h = await new PartsService({ env: {} as NodeJS.ProcessEnv }).describe()
    expect(h.provider).toBe('mock')
    expect(h.degraded).toBe(false)
    expect(h.missingSpec).toBeUndefined()
  })

  it('remote 可用时不 degraded，但仍报出缺的接入信息', async () => {
    const h = await new PartsService({
      env: { PARTS_PROVIDER: 'remote', PARTS_API_KEY: 'k' } as NodeJS.ProcessEnv,
    }).describe()
    expect(h.provider).toBe('remote')
    // 没发过请求就没有错误，degraded 应为 false —— 不能因为「信息不全」
    // 就一直报降级，那样真降级时就没人看了
    expect(h.degraded).toBe(false)
    expect(h.missingSpec?.length).toBeGreaterThan(0)
  })

  it('没给 key 时降级，原因指向 PARTS_API_KEY', async () => {
    const h = await new PartsService({
      env: { PARTS_PROVIDER: 'remote' } as NodeJS.ProcessEnv,
    }).describe()
    expect(h.degraded).toBe(true)
    expect(h.lastError).toMatch(/PARTS_API_KEY/)
  })

  it('无请求时 mirrorHit 是 null 而不是 0', async () => {
    // 0 会被误读成「全都没命中」
    const h = await new PartsService({ env: {} as NodeJS.ProcessEnv }).describe()
    expect(h.mirrorHit).toBeNull()
  })
})
