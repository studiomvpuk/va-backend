export interface TargetRoleView {
  id: string;
  title: string;
  criteria: string | null;
}

/**
 * The Client's target roles and criteria.
 *
 * Feeds the fit-assessment rubric in Phase 6 — this is the "what am I actually
 * looking for" half of a fit score, and the reason a 7.5 for one Client is a
 * 4.0 for another.
 */
export interface ITargetRoleRepository {
  list(): Promise<TargetRoleView[]>;
  replaceAll(roles: { title: string; criteria?: string }[]): Promise<TargetRoleView[]>;
}

export const TARGET_ROLE_REPOSITORY = Symbol('TARGET_ROLE_REPOSITORY');
