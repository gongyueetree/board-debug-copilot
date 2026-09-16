-- P1-P3 LabSight closed-loop data model.
-- Keep all writes project-scoped and preserve existing project data.

CREATE TYPE "DebugSessionStatus" AS ENUM ('OPEN', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "BoardStatus" AS ENUM ('UNKNOWN', 'PASS', 'FAIL', 'REWORK');
CREATE TYPE "EvidenceKind" AS ENUM ('IMAGE', 'MEASUREMENT', 'WAVEFORM', 'KICAD', 'VOICE', 'SESSION', 'INSTRUMENT', 'DIAGNOSIS', 'TEST_RESULT');
CREATE TYPE "SuggestionDraftKind" AS ENUM ('ISSUE', 'ECO');
CREATE TYPE "SuggestionDraftStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED');
CREATE TYPE "HypothesisStatus" AS ENUM ('OPEN', 'SUPPORTED', 'REJECTED', 'RESOLVED');

CREATE TABLE "Board" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "designVersion" INTEGER NOT NULL,
  "serialNo" TEXT,
  "batchNo" TEXT,
  "label" TEXT,
  "status" "BoardStatus" NOT NULL DEFAULT 'UNKNOWN',
  "isGolden" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Board_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DebugSession" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "boardId" TEXT,
  "designVersion" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "issue" TEXT,
  "goal" TEXT,
  "status" "DebugSessionStatus" NOT NULL DEFAULT 'OPEN',
  "ownerId" TEXT,
  "rootCauseCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "DebugSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabEvidence" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "kind" "EvidenceKind" NOT NULL,
  "ref" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "componentId" TEXT,
  "pinId" TEXT,
  "netId" TEXT,
  "testPointId" TEXT,
  "debugStepId" TEXT,
  "excerpt" TEXT,
  "dataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LabEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabSuggestionDraft" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "kind" "SuggestionDraftKind" NOT NULL,
  "status" "SuggestionDraftStatus" NOT NULL DEFAULT 'DRAFT',
  "payloadJson" JSONB NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "externalObjectId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LabSuggestionDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabHypothesis" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "statement" TEXT NOT NULL,
  "expectedObservation" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL,
  "status" "HypothesisStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LabHypothesis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LabTestRecommendation" (
  "id" TEXT NOT NULL,
  "hypothesisId" TEXT NOT NULL,
  "debugStepId" TEXT,
  "title" TEXT NOT NULL,
  "expectedObservation" TEXT,
  "informationGain" DOUBLE PRECISION NOT NULL,
  "safetyCost" DOUBLE PRECISION NOT NULL,
  "effortCost" DOUBLE PRECISION NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "why" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LabTestRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoldenBoardComparison" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "goldenBoardId" TEXT NOT NULL,
  "targetBoardId" TEXT,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoldenBoardComparison_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BoardPhoto" ADD COLUMN "boardId" TEXT;
ALTER TABLE "Capture" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "DebugStep" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "AiDiagnosis" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "AiThread" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "DebugReport" ADD COLUMN "sessionId" TEXT;

CREATE INDEX "Board_projectId_idx" ON "Board"("projectId");
CREATE UNIQUE INDEX "Board_projectId_serialNo_key" ON "Board"("projectId", "serialNo");
CREATE INDEX "DebugSession_projectId_status_idx" ON "DebugSession"("projectId", "status");
CREATE INDEX "DebugSession_boardId_idx" ON "DebugSession"("boardId");
CREATE INDEX "LabEvidence_projectId_idx" ON "LabEvidence"("projectId");
CREATE INDEX "LabEvidence_sessionId_createdAt_idx" ON "LabEvidence"("sessionId", "createdAt");
CREATE INDEX "LabEvidence_componentId_idx" ON "LabEvidence"("componentId");
CREATE INDEX "LabEvidence_pinId_idx" ON "LabEvidence"("pinId");
CREATE INDEX "LabEvidence_netId_idx" ON "LabEvidence"("netId");
CREATE INDEX "LabEvidence_testPointId_idx" ON "LabEvidence"("testPointId");
CREATE INDEX "LabEvidence_debugStepId_idx" ON "LabEvidence"("debugStepId");
CREATE UNIQUE INDEX "LabEvidence_sessionId_ref_key" ON "LabEvidence"("sessionId", "ref");
CREATE INDEX "LabSuggestionDraft_projectId_status_idx" ON "LabSuggestionDraft"("projectId", "status");
CREATE INDEX "LabSuggestionDraft_sessionId_idx" ON "LabSuggestionDraft"("sessionId");
CREATE INDEX "LabHypothesis_sessionId_status_idx" ON "LabHypothesis"("sessionId", "status");
CREATE INDEX "LabTestRecommendation_hypothesisId_score_idx" ON "LabTestRecommendation"("hypothesisId", "score");
CREATE INDEX "GoldenBoardComparison_projectId_createdAt_idx" ON "GoldenBoardComparison"("projectId", "createdAt");
CREATE INDEX "Capture_sessionId_idx" ON "Capture"("sessionId");
CREATE INDEX "DebugStep_sessionId_idx" ON "DebugStep"("sessionId");
CREATE INDEX "AiDiagnosis_sessionId_idx" ON "AiDiagnosis"("sessionId");
CREATE INDEX "AiThread_sessionId_idx" ON "AiThread"("sessionId");
CREATE INDEX "DebugReport_sessionId_idx" ON "DebugReport"("sessionId");
CREATE INDEX "BoardPhoto_boardId_idx" ON "BoardPhoto"("boardId");

ALTER TABLE "Board" ADD CONSTRAINT "Board_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebugSession" ADD CONSTRAINT "DebugSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebugSession" ADD CONSTRAINT "DebugSession_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_pinId_fkey" FOREIGN KEY ("pinId") REFERENCES "Pin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_testPointId_fkey" FOREIGN KEY ("testPointId") REFERENCES "TestPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabEvidence" ADD CONSTRAINT "LabEvidence_debugStepId_fkey" FOREIGN KEY ("debugStepId") REFERENCES "DebugStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LabSuggestionDraft" ADD CONSTRAINT "LabSuggestionDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabSuggestionDraft" ADD CONSTRAINT "LabSuggestionDraft_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabHypothesis" ADD CONSTRAINT "LabHypothesis_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabTestRecommendation" ADD CONSTRAINT "LabTestRecommendation_hypothesisId_fkey" FOREIGN KEY ("hypothesisId") REFERENCES "LabHypothesis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabTestRecommendation" ADD CONSTRAINT "LabTestRecommendation_debugStepId_fkey" FOREIGN KEY ("debugStepId") REFERENCES "DebugStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GoldenBoardComparison" ADD CONSTRAINT "GoldenBoardComparison_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoldenBoardComparison" ADD CONSTRAINT "GoldenBoardComparison_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoldenBoardComparison" ADD CONSTRAINT "GoldenBoardComparison_goldenBoardId_fkey" FOREIGN KEY ("goldenBoardId") REFERENCES "Board"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoldenBoardComparison" ADD CONSTRAINT "GoldenBoardComparison_targetBoardId_fkey" FOREIGN KEY ("targetBoardId") REFERENCES "Board"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BoardPhoto" ADD CONSTRAINT "BoardPhoto_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebugStep" ADD CONSTRAINT "DebugStep_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiDiagnosis" ADD CONSTRAINT "AiDiagnosis_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiThread" ADD CONSTRAINT "AiThread_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DebugReport" ADD CONSTRAINT "DebugReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DebugSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill one deterministic fallback session per existing project so old evidence is not orphaned.
INSERT INTO "DebugSession" ("id", "projectId", "designVersion", "title", "issue", "goal", "status", "createdAt", "updatedAt")
SELECT 'legacy-' || p."id", p."id", p."designVersion", '历史调试记录', p."currentIssue", '迁移前项目记录', 'OPEN', p."createdAt", CURRENT_TIMESTAMP
FROM "Project" p
ON CONFLICT ("id") DO NOTHING;

UPDATE "Capture" c SET "sessionId" = 'legacy-' || c."projectId" WHERE c."sessionId" IS NULL;
UPDATE "DebugStep" s SET "sessionId" = 'legacy-' || s."projectId" WHERE s."sessionId" IS NULL;
UPDATE "AiDiagnosis" d SET "sessionId" = 'legacy-' || d."projectId" WHERE d."sessionId" IS NULL;
UPDATE "AiThread" t SET "sessionId" = 'legacy-' || t."projectId" WHERE t."sessionId" IS NULL;
UPDATE "DebugReport" r SET "sessionId" = 'legacy-' || r."projectId" WHERE r."sessionId" IS NULL;