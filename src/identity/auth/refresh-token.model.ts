/**
 * Mirrors the Prisma `SubjectType` enum.
 *
 * Declared here rather than imported from @prisma/client so that domain code
 * and its tests do not depend on a generated artifact. The architecture test
 * asserts the two stay in step.
 */
export type SubjectType = 'CLIENT' | 'VA';
