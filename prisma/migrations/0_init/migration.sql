-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "GapMode" AS ENUM ('GUESS_AND_PROCEED', 'ASK_FIRST');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('GENERAL', 'SENSITIVE');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('ANTHROPIC', 'OPENAI');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('SCORED', 'SKIPPED', 'IN_PROGRESS', 'BLOCKED', 'APPLIED', 'INTERVIEW', 'REJECTED', 'OFFER');

-- CreateEnum
CREATE TYPE "SeniorityVerdict" AS ENUM ('UNDER_LEVELLED', 'MATCHED', 'OVER_LEVELLED');

-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('CV', 'COVER_LETTER', 'SCREENING_ANSWER');

-- CreateEnum
CREATE TYPE "MsgRole" AS ENUM ('VA', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PrepStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "NotifKind" AS ENUM ('KNOWLEDGE_GAP', 'CREDENTIAL_REVEAL', 'AGREEMENT_SIGNED', 'RATE_LIMIT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('CLIENT', 'VA');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('CLIENT', 'VA', 'SYSTEM');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientSettings" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "gapMode" "GapMode" NOT NULL DEFAULT 'GUESS_AND_PROCEED',
    "minFitScore" DECIMAL(3,1) NOT NULL DEFAULT 6.0,
    "byokEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappNumber" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileField" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'GENERAL',
    "value" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensitiveValue" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "profileFieldId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SensitiveValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperienceNarrative" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExperienceNarrative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" "SiteStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialReveal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialReveal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialAcknowledgement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderKey" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "hint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetRole" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "criteria" TEXT,

    CONSTRAINT "TargetRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VirtualAssistant" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "inviteToken" TEXT,
    "inviteExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "VirtualAssistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agreement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "signedName" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "vaId" TEXT,
    "siteId" TEXT,
    "companyName" TEXT NOT NULL,
    "roleTitle" TEXT NOT NULL,
    "jobDescription" TEXT NOT NULL,
    "fitScore" DECIMAL(3,1),
    "fitReasoning" TEXT,
    "seniorityVerdict" "SeniorityVerdict",
    "status" "AppStatus" NOT NULL DEFAULT 'SCORED',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "DraftKind" NOT NULL,
    "questionText" TEXT,
    "body" TEXT NOT NULL,
    "orchestrationPath" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "atsChecked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGap" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "bestEffortAnswer" TEXT,
    "clientAnswer" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaBankEntry" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "sourceGapId" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaBankEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "vaId" TEXT NOT NULL,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "MsgRole" NOT NULL,
    "body" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "gapId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrepDocument" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "PrepStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "companyBackground" TEXT,
    "likelyQuestions" JSONB NOT NULL DEFAULT '[]',
    "talkingPoints" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrepDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "NotifKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkPath" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ClientSettings_clientId_key" ON "ClientSettings"("clientId");

-- CreateIndex
CREATE INDEX "ProfileField_clientId_idx" ON "ProfileField"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileField_clientId_key_key" ON "ProfileField"("clientId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SensitiveValue_profileFieldId_key" ON "SensitiveValue"("profileFieldId");

-- CreateIndex
CREATE INDEX "SensitiveValue_clientId_idx" ON "SensitiveValue"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ExperienceNarrative_clientId_key" ON "ExperienceNarrative"("clientId");

-- CreateIndex
CREATE INDEX "Site_clientId_idx" ON "Site"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_clientId_name_key" ON "Site"("clientId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_siteId_key" ON "Credential"("siteId");

-- CreateIndex
CREATE INDEX "Credential_clientId_idx" ON "Credential"("clientId");

-- CreateIndex
CREATE INDEX "CredentialReveal_clientId_createdAt_idx" ON "CredentialReveal"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "CredentialReveal_credentialId_expiresAt_idx" ON "CredentialReveal"("credentialId", "expiresAt");

-- CreateIndex
CREATE INDEX "CredentialAcknowledgement_clientId_idx" ON "CredentialAcknowledgement"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialAcknowledgement_credentialId_vaId_key" ON "CredentialAcknowledgement"("credentialId", "vaId");

-- CreateIndex
CREATE INDEX "ProviderKey_clientId_idx" ON "ProviderKey"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderKey_clientId_provider_key" ON "ProviderKey"("clientId", "provider");

-- CreateIndex
CREATE INDEX "TargetRole_clientId_idx" ON "TargetRole"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAssistant_inviteToken_key" ON "VirtualAssistant"("inviteToken");

-- CreateIndex
CREATE INDEX "VirtualAssistant_clientId_idx" ON "VirtualAssistant"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAssistant_clientId_email_key" ON "VirtualAssistant"("clientId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_vaId_key" ON "Agreement"("vaId");

-- CreateIndex
CREATE INDEX "Agreement_clientId_idx" ON "Agreement"("clientId");

-- CreateIndex
CREATE INDEX "Application_clientId_status_idx" ON "Application"("clientId", "status");

-- CreateIndex
CREATE INDEX "Application_clientId_createdAt_idx" ON "Application"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Draft_clientId_applicationId_idx" ON "Draft"("clientId", "applicationId");

-- CreateIndex
CREATE INDEX "KnowledgeGap_clientId_resolvedAt_idx" ON "KnowledgeGap"("clientId", "resolvedAt");

-- CreateIndex
CREATE INDEX "QaBankEntry_clientId_idx" ON "QaBankEntry"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "QaBankEntry_clientId_questionKey_key" ON "QaBankEntry"("clientId", "questionKey");

-- CreateIndex
CREATE INDEX "Thread_clientId_vaId_idx" ON "Thread"("clientId", "vaId");

-- CreateIndex
CREATE INDEX "Message_clientId_threadId_createdAt_idx" ON "Message"("clientId", "threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrepDocument_applicationId_key" ON "PrepDocument"("applicationId");

-- CreateIndex
CREATE INDEX "PrepDocument_clientId_idx" ON "PrepDocument"("clientId");

-- CreateIndex
CREATE INDEX "Notification_clientId_readAt_idx" ON "Notification"("clientId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_subjectType_subjectId_idx" ON "RefreshToken"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditEvent_clientId_createdAt_idx" ON "AuditEvent"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_clientId_action_idx" ON "AuditEvent"("clientId", "action");

-- AddForeignKey
ALTER TABLE "ClientSettings" ADD CONSTRAINT "ClientSettings_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileField" ADD CONSTRAINT "ProfileField_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensitiveValue" ADD CONSTRAINT "SensitiveValue_profileFieldId_fkey" FOREIGN KEY ("profileFieldId") REFERENCES "ProfileField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperienceNarrative" ADD CONSTRAINT "ExperienceNarrative_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialReveal" ADD CONSTRAINT "CredentialReveal_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialAcknowledgement" ADD CONSTRAINT "CredentialAcknowledgement_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetRole" ADD CONSTRAINT "TargetRole_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VirtualAssistant" ADD CONSTRAINT "VirtualAssistant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "VirtualAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "VirtualAssistant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGap" ADD CONSTRAINT "KnowledgeGap_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGap" ADD CONSTRAINT "KnowledgeGap_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGap" ADD CONSTRAINT "KnowledgeGap_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "VirtualAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaBankEntry" ADD CONSTRAINT "QaBankEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_vaId_fkey" FOREIGN KEY ("vaId") REFERENCES "VirtualAssistant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrepDocument" ADD CONSTRAINT "PrepDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

