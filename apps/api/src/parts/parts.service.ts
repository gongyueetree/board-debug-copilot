import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

export interface PartKnowledge {
  partNumber: string
  manufacturer: string | null
  category: string
  summary: string
  params: Record<string, unknown>
  source: string
  /** 向量检索时的余弦相似度；关键词命中为 null */
  score?: number | null
}

/**
 * PartsDatabaseAdapter（docs/00 §12）。
 *
 * 三级降级：pgvector 向量检索 → SQL 关键词匹配 → 内置常识库。
 * 内置库只给常识参数，绝不假装有真实库存和价格。
 */
const BUILTIN: PartKnowledge[] = [
  {
    partNumber: 'AD8605',
    manufacturer: 'Analog Devices',
    category: '运算放大器',
    summary: '低噪声 CMOS 精密运放，轨到轨输入输出，单电源工作',
    params: {
      supplyRange: '2.7~5.5 V',
      absMaxSupply: '6 V',
      inputBiasCurrent: '1 pA',
      gbw: '10 MHz',
      output: 'rail-to-rail (±20 mV)',
      note: '单电源下反相放大必须把同相端偏置到轨中点，否则输出被钳在轨底',
    },
    source: 'BUILTIN',
  },
  {
    partNumber: 'MCP4725',
    manufacturer: 'Microchip',
    category: 'DAC',
    summary: '12 位 I2C 接口 DAC，带 EEPROM',
    params: { resolution: '12-bit', interface: 'I2C', maxClock: '3.4 MHz', addressPins: 1 },
    source: 'BUILTIN',
  },
  {
    partNumber: 'TPS7A02',
    manufacturer: 'Texas Instruments',
    category: 'LDO 稳压器',
    summary: '超低静态电流 LDO，200 mA 输出',
    params: { iout: '200 mA', iq: '25 nA', dropout: '190 mV', coutMin: '1 µF', coutRecommended: '10 µF' },
    source: 'BUILTIN',
  },
  {
    partNumber: 'OPA192',
    manufacturer: 'Texas Instruments',
    category: '运算放大器',
    summary: '精密轨到轨运放，宽供电范围',
    params: { supplyRange: '±2.25~±18 V', inputBiasCurrent: '5 pA', gbw: '10 MHz', output: 'rail-to-rail' },
    source: 'BUILTIN',
  },
]

@Injectable()
export class PartsService {
  private readonly logger = new Logger(PartsService.name)
  private vectorReady: boolean | null = null

  constructor(private readonly prisma: PrismaService) {}

  /** 探测一次 pgvector 是否可用，结果缓存 */
  private async hasVector(): Promise<boolean> {
    if (this.vectorReady !== null) return this.vectorReady
    try {
      const r = await this.prisma.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`,
      )
      this.vectorReady = Boolean(r[0]?.ok)
    } catch {
      this.vectorReady = false
    }
    if (!this.vectorReady) {
      this.logger.log('pgvector 不可用，器件检索降级为关键词匹配 + 内置常识库')
    }
    return this.vectorReady
  }

  /** 精确查型号；先查库再回落内置 */
  async lookup(partNumber: string): Promise<PartKnowledge | null> {
    const key = partNumber.trim().toUpperCase()
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { partNumber: string; manufacturer: string | null; category: string; summary: string; paramsJson: unknown; source: string }[]
      >(
        `SELECT "partNumber","manufacturer","category","summary","paramsJson","source"
         FROM "PartKnowledge" WHERE UPPER("partNumber") = $1 LIMIT 1`,
        key,
      )
      const r = rows[0]
      if (r) {
        return {
          partNumber: r.partNumber,
          manufacturer: r.manufacturer,
          category: r.category,
          summary: r.summary,
          params: (r.paramsJson ?? {}) as Record<string, unknown>,
          source: r.source,
        }
      }
    } catch {
      /* 表不存在也不影响，走内置 */
    }
    // 型号常带后缀（AD8605ARZ），用前缀匹配兜底
    return BUILTIN.find((b) => key.startsWith(b.partNumber)) ?? null
  }

  /**
   * 语义检索。有 embedding 时走 pgvector 余弦距离，否则关键词。
   * 上层（DesignDigest）不需要知道走的是哪条路。
   */
  async search(query: string, limit = 5): Promise<PartKnowledge[]> {
    const embedding = await this.embed(query)

    if (embedding && (await this.hasVector())) {
      try {
        const literal = `[${embedding.join(',')}]`
        const rows = await this.prisma.$queryRawUnsafe<
          { partNumber: string; manufacturer: string | null; category: string; summary: string; paramsJson: unknown; source: string; score: number }[]
        >(
          `SELECT "partNumber","manufacturer","category","summary","paramsJson","source",
                  1 - ("embedding" <=> $1::vector) AS score
           FROM "PartKnowledge"
           WHERE "embedding" IS NOT NULL
           ORDER BY "embedding" <=> $1::vector
           LIMIT $2`,
          literal,
          limit,
        )
        if (rows.length > 0) {
          return rows.map((r) => ({
            partNumber: r.partNumber,
            manufacturer: r.manufacturer,
            category: r.category,
            summary: r.summary,
            params: (r.paramsJson ?? {}) as Record<string, unknown>,
            source: r.source,
            score: r.score,
          }))
        }
      } catch (err) {
        this.logger.warn(`向量检索失败，降级关键词：${(err as Error).message}`)
      }
    }

    const kw = query.toLowerCase()
    return BUILTIN.filter(
      (b) =>
        b.partNumber.toLowerCase().includes(kw) ||
        b.category.includes(query) ||
        b.summary.includes(query),
    ).slice(0, limit)
  }

  /**
   * 生成 embedding。EMBEDDING_PROVIDER=gemini 时调真实接口，否则返回 null
   * 让调用方走关键词路径 —— 不做假向量，那只会让检索结果看起来能用其实是噪声。
   */
  private async embed(text: string): Promise<number[] | null> {
    const provider = (process.env.EMBEDDING_PROVIDER ?? 'mock').toLowerCase()
    const key = process.env.EMBEDDING_API_KEY ?? process.env.GEMINI_API_KEY
    if (provider !== 'gemini' || !key) return null

    try {
      const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-004'
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            outputDimensionality: 768,
          }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { embedding?: { values?: number[] } }
      return d.embedding?.values ?? null
    } catch (err) {
      this.logger.warn(`embedding 生成失败：${(err as Error).message}`)
      return null
    }
  }

  /** 把内置常识库写入数据库并（如可用）生成向量 */
  async seedBuiltin(): Promise<{ inserted: number; embedded: number }> {
    let inserted = 0
    let embedded = 0

    for (const p of BUILTIN) {
      try {
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "PartKnowledge" ("id","partNumber","manufacturer","category","summary","paramsJson","source")
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
           ON CONFLICT ("partNumber") DO UPDATE
             SET "summary" = EXCLUDED."summary", "paramsJson" = EXCLUDED."paramsJson"`,
          p.partNumber.toLowerCase(),
          p.partNumber,
          p.manufacturer,
          p.category,
          p.summary,
          JSON.stringify(p.params),
          p.source,
        )
        inserted++

        const vec = await this.embed(`${p.partNumber} ${p.category} ${p.summary}`)
        if (vec && (await this.hasVector())) {
          await this.prisma.$executeRawUnsafe(
            `UPDATE "PartKnowledge" SET "embedding" = $1::vector WHERE "partNumber" = $2`,
            `[${vec.join(',')}]`,
            p.partNumber,
          )
          embedded++
        }
      } catch (err) {
        this.logger.warn(`器件 ${p.partNumber} 写入失败：${(err as Error).message}`)
      }
    }
    return { inserted, embedded }
  }
}
