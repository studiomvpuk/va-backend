/**
 * Every model carrying a clientId.
 *
 * A model added to schema.prisma with a clientId column and NOT added here is
 * unscoped, which is the one mistake this whole mechanism exists to prevent.
 * The architecture test in test/architecture/ reads the Prisma schema and fails
 * CI if the two lists disagree.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'ClientSettings',
  'ProfileField',
  'SensitiveValue',
  'ExperienceNarrative',
  'Site',
  'Credential',
  'CredentialReveal',
  'CredentialAcknowledgement',
  'ProviderKey',
  'TargetRole',
  'VirtualAssistant',
  'Agreement',
  'Application',
  'Draft',
  'KnowledgeGap',
  'QaBankEntry',
  'Thread',
  'Message',
  'PrepDocument',
  'Notification',
  'AuditEvent',
]);
