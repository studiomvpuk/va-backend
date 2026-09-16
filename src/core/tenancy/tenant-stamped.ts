/**
 * The type-level counterpart to the extension's create-stamping (PRD §2.5).
 *
 * `tenantScopedExtension` writes `clientId` into the payload of every create,
 * createMany and upsert before it reaches the database. Repositories therefore
 * deliberately do not supply it — that is the whole design, and a repository
 * that supplied a different one would be rejected outright by
 * `CrossTenantWriteError`. Prisma's generated create inputs cannot see that
 * runtime step, so they require either `clientId` or a connected `client`.
 *
 * This is the one place that gap is bridged, and it is shaped like
 * `runUnscoped` on purpose: a single named function, so the hole is greppable,
 * reviewable, and held to the repository layer by an architecture test. The
 * alternative — an `any` or a bare cast at each call site — would switch off
 * checking for every *other* field too, which is exactly what we do not want.
 *
 * What each call site still typechecks: every field except `clientId`, against
 * the real generated input type. Getting a column name or an enum value wrong
 * is still a compile error.
 *
 * Deliberately type-level only. The runtime guard lives in the extension, which
 * throws `MissingTenantContextError` naming the model; a second guard here
 * could only ever disagree with it.
 */
export type WithoutTenant<TCreateInput> = Omit<TCreateInput, 'clientId'>;

export function stampedByTenant<TCreateInput extends { clientId: string }>(
  data: WithoutTenant<TCreateInput>,
): TCreateInput {
  return data as TCreateInput;
}

/** The `createMany` form: the extension stamps every row in the array. */
export function stampedByTenantMany<TCreateInput extends { clientId: string }>(
  rows: WithoutTenant<TCreateInput>[],
): TCreateInput[] {
  return rows as TCreateInput[];
}
