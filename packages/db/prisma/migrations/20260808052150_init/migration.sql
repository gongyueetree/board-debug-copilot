-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('CREATED', 'UPLOADED', 'PARSING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('KICAD_ZIP', 'KICAD_PROJECT', 'SCHEMATIC', 'PCB', 'BOM', 'NETLIST', 'ERC_REPORT', 'DRC_REPORT', 'PCB_PHOTO', 'CAPTURE_FILE', 'REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "CaptureKind" AS ENUM ('OSCILLOSCOPE', 'FFT', 'BODE', 'LOGIC', 'DMM', 'POWER');

-- CreateEnum
CREATE TYPE "DiagnosisSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'CREATED',
    "currentIssue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFile" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "parseStatus" TEXT,
    "parseLog" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Component" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "value" TEXT,
    "symbol" TEXT,
    "footprint" TEXT,
    "partNumber" TEXT,
    "manufacturer" TEXT,
    "datasheetUrl" TEXT,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "rotation" DOUBLE PRECISION,
    "side" TEXT,
    "rawJson" JSONB,

    CONSTRAINT "Component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pin" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT,
    "netId" TEXT,

    CONSTRAINT "Pin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Net" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "netClass" TEXT,
    "inferredRole" TEXT,
    "expectedVoltage" TEXT,
    "expectedFrequency" TEXT,
    "rawJson" JSONB,

    CONSTRAINT "Net_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestPoint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "componentId" TEXT,
    "netId" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartMatch" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalPartId" TEXT,
    "matchedPartNumber" TEXT,
    "confidence" DOUBLE PRECISION,
    "summaryJson" JSONB,

    CONSTRAINT "PartMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleViolation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "DiagnosisSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT,
    "risk" TEXT,
    "suggestion" TEXT,
    "recommendedTest" TEXT,
    "componentRef" TEXT,
    "netName" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardPhoto" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "side" TEXT,
    "alignmentJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoAnnotation" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "componentId" TEXT,
    "netName" TEXT,
    "kind" TEXT NOT NULL,
    "regionJson" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualFinding" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "componentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capture" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "netId" TEXT,
    "kind" "CaptureKind" NOT NULL,
    "label" TEXT,
    "hardwareSetupJson" JSONB NOT NULL,
    "measurementsJson" JSONB NOT NULL,
    "waveformObjectKey" TEXT,
    "thumbnailObjectKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "debugStepId" TEXT,

    CONSTRAINT "Capture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDiagnosis" (
    "id" TEXT NOT NULL,
    "captureId" TEXT,
    "projectId" TEXT NOT NULL,
    "severity" "DiagnosisSeverity" NOT NULL,
    "rootCause" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "recommendationsJson" JSONB NOT NULL,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDiagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebugStep" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "toolHint" TEXT,
    "estimateMin" INTEGER,
    "setupJson" JSONB,
    "targetNet" TEXT,
    "targetComponent" TEXT,
    "expectedResult" TEXT,
    "abnormalNext" TEXT,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebugStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiThread" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "messagesJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebugReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v1.0',
    "author" TEXT,
    "coverObjectKey" TEXT,
    "markdown" TEXT NOT NULL,
    "tocJson" JSONB,
    "statsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebugReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ProjectFile_projectId_idx" ON "ProjectFile"("projectId");

-- CreateIndex
CREATE INDEX "Component_projectId_idx" ON "Component"("projectId");

-- CreateIndex
CREATE INDEX "Component_projectId_ref_idx" ON "Component"("projectId", "ref");

-- CreateIndex
CREATE INDEX "Pin_componentId_idx" ON "Pin"("componentId");

-- CreateIndex
CREATE INDEX "Pin_netId_idx" ON "Pin"("netId");

-- CreateIndex
CREATE INDEX "Net_projectId_idx" ON "Net"("projectId");

-- CreateIndex
CREATE INDEX "Net_projectId_name_idx" ON "Net"("projectId", "name");

-- CreateIndex
CREATE INDEX "TestPoint_projectId_idx" ON "TestPoint"("projectId");

-- CreateIndex
CREATE INDEX "PartMatch_componentId_idx" ON "PartMatch"("componentId");

-- CreateIndex
CREATE INDEX "RuleViolation_projectId_idx" ON "RuleViolation"("projectId");

-- CreateIndex
CREATE INDEX "RuleViolation_projectId_severity_idx" ON "RuleViolation"("projectId", "severity");

-- CreateIndex
CREATE INDEX "BoardPhoto_projectId_idx" ON "BoardPhoto"("projectId");

-- CreateIndex
CREATE INDEX "PhotoAnnotation_photoId_idx" ON "PhotoAnnotation"("photoId");

-- CreateIndex
CREATE INDEX "VisualFinding_photoId_idx" ON "VisualFinding"("photoId");

-- CreateIndex
CREATE INDEX "Capture_projectId_idx" ON "Capture"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AiDiagnosis_captureId_key" ON "AiDiagnosis"("captureId");

-- CreateIndex
CREATE INDEX "AiDiagnosis_projectId_idx" ON "AiDiagnosis"("projectId");

-- CreateIndex
CREATE INDEX "DebugStep_projectId_idx" ON "DebugStep"("projectId");

-- CreateIndex
CREATE INDEX "DebugStep_parentId_idx" ON "DebugStep"("parentId");

-- CreateIndex
CREATE INDEX "AiThread_projectId_mode_idx" ON "AiThread"("projectId", "mode");

-- CreateIndex
CREATE INDEX "DebugReport_projectId_idx" ON "DebugReport"("projectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFile" ADD CONSTRAINT "ProjectFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Component" ADD CONSTRAINT "Component_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pin" ADD CONSTRAINT "Pin_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pin" ADD CONSTRAINT "Pin_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Net" ADD CONSTRAINT "Net_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPoint" ADD CONSTRAINT "TestPoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPoint" ADD CONSTRAINT "TestPoint_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPoint" ADD CONSTRAINT "TestPoint_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartMatch" ADD CONSTRAINT "PartMatch_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleViolation" ADD CONSTRAINT "RuleViolation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardPhoto" ADD CONSTRAINT "BoardPhoto_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAnnotation" ADD CONSTRAINT "PhotoAnnotation_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "BoardPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoAnnotation" ADD CONSTRAINT "PhotoAnnotation_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualFinding" ADD CONSTRAINT "VisualFinding_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "BoardPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_netId_fkey" FOREIGN KEY ("netId") REFERENCES "Net"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_debugStepId_fkey" FOREIGN KEY ("debugStepId") REFERENCES "DebugStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDiagnosis" ADD CONSTRAINT "AiDiagnosis_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "Capture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebugStep" ADD CONSTRAINT "DebugStep_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebugStep" ADD CONSTRAINT "DebugStep_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DebugStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiThread" ADD CONSTRAINT "AiThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebugReport" ADD CONSTRAINT "DebugReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
