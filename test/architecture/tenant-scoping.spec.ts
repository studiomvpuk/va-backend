import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS } from '../../src/core/tenancy/tenant-scoped.models';

/**
 * Architecture test (PRD §8).
 *
 * A model added to schema.prisma with a clientId column but NOT registered in
 * TENANT_SCOPED_MODELS would be silently unscoped — exactly the mistake the
 * isolation mechanism exists to prevent. This test makes that mistake fail CI
 * instead of shipping.
 */
describe('tenant scoping registry', () => {
  const schema = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );

  const modelsWithClientId = [...schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /^\s*clientId\s+String/m.test(body))
    .map(([, name]) => name);

  it('finds models to check (guards against a broken regex passing vacuously)', () => {
    expect(modelsWithClientId.length).toBeGreaterThan(5);
  });

  it.each(modelsWithClientId)('%s is registered as tenant-scoped', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });

  it('registers nothing that does not exist in the schema', () => {
    const declared = [...schema.matchAll(/model\s+(\w+)\s*\{/g)].map(([, n]) => n);
    for (const registered of TENANT_SCOPED_MODELS) {
      expect(declared).toContain(registered);
    }
  });
});
