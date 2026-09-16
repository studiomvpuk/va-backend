import { evaluateSharingGate } from './sharing-gate';

const t = (iso: string) => new Date(iso);

describe('the §7.4 sharing gate', () => {
  const vaOnboardedAt = t('2026-06-01T12:00:00Z');

  it('blocks a password that predates the VA and was never rotated', () => {
    expect(
      evaluateSharingGate({
        credentialSetAt: t('2026-01-01T00:00:00Z'),
        credentialRotatedAt: null,
        vaOnboardedAt,
        hasAcknowledgement: false,
      }),
    ).toEqual({ allowed: false, reason: 'needs_rotation_or_acknowledgement' });
  });

  it('allows one rotated after the VA was onboarded', () => {
    expect(
      evaluateSharingGate({
        credentialSetAt: t('2026-01-01T00:00:00Z'),
        credentialRotatedAt: t('2026-06-02T09:00:00Z'),
        vaOnboardedAt,
        hasAcknowledgement: false,
      }).allowed,
    ).toBe(true);
  });

  it('still blocks when the rotation happened BEFORE the VA joined', () => {
    // A rotation in March says nothing about a VA who arrived in June.
    expect(
      evaluateSharingGate({
        credentialSetAt: t('2026-01-01T00:00:00Z'),
        credentialRotatedAt: t('2026-03-01T00:00:00Z'),
        vaOnboardedAt,
        hasAcknowledgement: false,
      }).allowed,
    ).toBe(false);
  });

  it('allows a credential ADDED after the VA joined — there is nothing to rotate', () => {
    expect(
      evaluateSharingGate({
        credentialSetAt: t('2026-07-01T00:00:00Z'),
        credentialRotatedAt: null,
        vaOnboardedAt,
        hasAcknowledgement: false,
      }),
    ).toEqual({ allowed: true, reason: 'rotated_after_onboarding' });
  });

  it('allows an explicit acknowledgement', () => {
    expect(
      evaluateSharingGate({
        credentialSetAt: t('2026-01-01T00:00:00Z'),
        credentialRotatedAt: null,
        vaOnboardedAt,
        hasAcknowledgement: true,
      }),
    ).toEqual({ allowed: true, reason: 'acknowledged' });
  });

  it('is exact at the boundary — same instant does not count as after', () => {
    expect(
      evaluateSharingGate({
        credentialSetAt: vaOnboardedAt,
        credentialRotatedAt: null,
        vaOnboardedAt,
        hasAcknowledgement: false,
      }).allowed,
    ).toBe(false);
  });

  it('reports WHY it allowed, so the audit log can record which path was taken', () => {
    const rotated = evaluateSharingGate({
      credentialSetAt: t('2026-07-01T00:00:00Z'),
      credentialRotatedAt: null,
      vaOnboardedAt,
      hasAcknowledgement: true,
    });
    // Rotation wins over acknowledgement — the stronger reason is the true one.
    expect(rotated).toEqual({ allowed: true, reason: 'rotated_after_onboarding' });
  });
});
