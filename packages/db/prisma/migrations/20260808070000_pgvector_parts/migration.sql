-- pgvector 器件知识库（docs/05 §16.3：MVP 之后接真实百万器件库时的接入点）
--
-- 不放进 schema.prisma：Prisma 没有原生 vector 类型，硬塞会让 migrate 与
-- generate 都变别扭。用原始 SQL 建表 + $queryRaw 查询，Prisma 只管其余模型。
-- 扩展装不上时整段跳过，MOCK_MODE 下 adapter 会走内置常识库。

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector 不可用，器件检索将降级为关键词匹配: %', SQLERRM;
END $$;

CREATE TABLE IF NOT EXISTS "PartKnowledge" (
  "id"           TEXT PRIMARY KEY,
  "partNumber"   TEXT NOT NULL,
  "manufacturer" TEXT,
  "category"     TEXT NOT NULL,
  "summary"      TEXT NOT NULL,
  "paramsJson"   JSONB NOT NULL DEFAULT '{}',
  "source"       TEXT NOT NULL DEFAULT 'BUILTIN',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "PartKnowledge_partNumber_key" ON "PartKnowledge"("partNumber");
CREATE INDEX IF NOT EXISTS "PartKnowledge_category_idx" ON "PartKnowledge"("category");

-- 向量列单独加：扩展缺失时这一步失败不影响上面的表可用
DO $$
BEGIN
  ALTER TABLE "PartKnowledge" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
  CREATE INDEX IF NOT EXISTS "PartKnowledge_embedding_idx"
    ON "PartKnowledge" USING hnsw ("embedding" vector_cosine_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '向量列/索引创建跳过: %', SQLERRM;
END $$;
