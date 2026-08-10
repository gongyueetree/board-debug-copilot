/**
 * 迁移文件的结构守卫。
 *
 * `prisma migrate diff` 每次都会想删掉 PartKnowledge 上的 HNSW 索引 ——
 * 它由原始 SQL 创建，Prisma 表达不了向量索引，所以 diff 看不见它的存在意义。
 *
 * 删掉的后果是**向量检索退化成全表扫描，而且不报错，只是变慢**。
 * 这种失败没有任何信号，只能靠这里挡住。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATIONS = join(__dirname, '../prisma/migrations')

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((d) => statSync(join(MIGRATIONS, d)).isDirectory())
  .map((d) => ({ name: d, path: join(MIGRATIONS, d, 'migration.sql') }))

describe('迁移文件', () => {
  it('至少有一个迁移', () => {
    expect(migrationFiles.length).toBeGreaterThan(0)
  })

  it.each(migrationFiles)('$name 不删 HNSW 向量索引', ({ path }) => {
    const sql = readFileSync(path, 'utf8')
    // 只看真正的语句，注释里提到它是允许的（我们就在注释里解释了为什么不能删）
    const statements = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/DROP\s+INDEX[^;]*PartKnowledge_embedding_idx/i)
  })

  it.each(migrationFiles)('$name 不删 PartKnowledge 表', ({ path }) => {
    const sql = readFileSync(path, 'utf8')
    const statements = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    // 同理：diff 看不到由原始 SQL 建的表，会想 DROP TABLE 重建
    expect(statements).not.toMatch(/DROP\s+TABLE[^;]*"?PartKnowledge"?/i)
  })

  it('P9 迁移只加不减：不含任何 DROP COLUMN', () => {
    const p9 = migrationFiles.find((m) => m.name.includes('p9_parts_database'))
    expect(p9).toBeDefined()
    const sql = readFileSync(p9!.path, 'utf8')
    expect(sql).not.toMatch(/DROP\s+COLUMN/i)
  })
})
