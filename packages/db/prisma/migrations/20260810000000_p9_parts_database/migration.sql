-- P9 器件库接入层
--
-- 只加列加表，不动任何既有关系。
--
-- 注意：`prisma migrate diff` 在这里生成过一句
--   DROP INDEX "PartKnowledge_embedding_idx";
-- 已手工删除。那个 HNSW 索引由 20260808070000_pgvector_parts 的原始 SQL 创建，
-- Prisma 表达不了向量索引，所以每次 diff 都会以为它是多余的。
-- 删掉它 = 向量检索退化成全表扫描，而且不会报错，只会变慢 —— docs/07 §7 已明确要求忽略。

-- CreateEnum
CREATE TYPE "PartCategory" AS ENUM ('OPAMP', 'LDO', 'DCDC', 'ADC', 'DAC', 'MCU', 'FPGA', 'MEMORY', 'RESISTOR', 'CAPACITOR', 'INDUCTOR', 'DIODE', 'LED', 'MOSFET', 'BJT', 'CRYSTAL', 'CONNECTOR', 'SENSOR', 'TRANSCEIVER', 'OTHER');

-- CreateEnum
CREATE TYPE "PartLifecycle" AS ENUM ('ACTIVE', 'NRND', 'EOL', 'OBSOLETE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT', 'PREFIX', 'PARAMETRIC', 'VECTOR', 'MANUAL');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'NEEDS_REVIEW', 'REJECTED');

-- AlterTable
ALTER TABLE "Component" ADD COLUMN     "matchStatus" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
ADD COLUMN     "partId" TEXT;

-- AlterTable
ALTER TABLE "PartKnowledge" ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "partId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PartMatch" ADD COLUMN     "accepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "method" "MatchMethod" NOT NULL DEFAULT 'EXACT',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT;

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "mpn" TEXT NOT NULL,
    "rawMpn" TEXT NOT NULL,
    "manufacturer" TEXT,
    "category" "PartCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "packageCase" TEXT,
    "datasheetUrl" TEXT,
    "lifecycle" "PartLifecycle" NOT NULL DEFAULT 'UNKNOWN',
    "rohs" BOOLEAN,
    "paramsJson" JSONB NOT NULL DEFAULT '{}',
    "commercialJson" JSONB,
    "sourceProvider" TEXT NOT NULL,
    "sourceId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartAlternate" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "altMpn" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,

    CONSTRAINT "PartAlternate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Part_mpn_key" ON "Part"("mpn");

-- CreateIndex
CREATE INDEX "Part_category_idx" ON "Part"("category");

-- CreateIndex
CREATE INDEX "Part_manufacturer_idx" ON "Part"("manufacturer");

-- CreateIndex
CREATE INDEX "Part_expiresAt_idx" ON "Part"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartAlternate_partId_altMpn_key" ON "PartAlternate"("partId", "altMpn");

-- CreateIndex
CREATE UNIQUE INDEX "PartKnowledge_partId_key" ON "PartKnowledge"("partId");

-- AddForeignKey
ALTER TABLE "Component" ADD CONSTRAINT "Component_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartAlternate" ADD CONSTRAINT "PartAlternate_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartKnowledge" ADD CONSTRAINT "PartKnowledge_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

