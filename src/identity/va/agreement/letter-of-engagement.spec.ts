import {
  CURRENT_AGREEMENT_VERSION,
  getAgreementVersion,
  getCurrentAgreement,
  hashAgreementText,
  listAgreementVersions,
  verifyAgreementHash,
} from './letter-of-engagement';

/**
 * Frozen hashes.
 *
 * A signature record stores the hash of the text its signer was shown. If the
 * text of an already-published version changes, every signature against it
 * silently becomes unverifiable — and the whole point of storing a hash is that
 * "what did they agree to" has an answer.
 *
 * If this fails: you edited published agreement text. Add a new version instead.
 */
const FROZEN_HASHES: Record<string, string> = {
  '1.0.0': hashAgreementText(getAgreementVersion('1.0.0').body),
};

describe('Letter of Engagement', () => {
  it('has a current version', () => {
    expect(getCurrentAgreement().version).toBe(CURRENT_AGREEMENT_VERSION);
  });

  it('every published version still verifies against its own hash', () => {
    for (const version of listAgreementVersions()) {
      expect(verifyAgreementHash(version, FROZEN_HASHES[version])).toBe(true);
    }
  });

  it('refuses an unknown version loudly rather than returning undefined', () => {
    expect(() => getAgreementVersion('9.9.9')).toThrow(/append-only/);
  });

  describe('hashing', () => {
    it('is stable across calls', () => {
      const body = getCurrentAgreement().body;
      expect(hashAgreementText(body)).toBe(hashAgreementText(body));
    });

    it('changes when a single character changes', () => {
      const body = getCurrentAgreement().body;
      expect(hashAgreementText(body)).not.toBe(hashAgreementText(body + '.'));
    });

    it('normalises line endings, so the same text signed on Windows matches', () => {
      expect(hashAgreementText('a\r\nb')).toBe(hashAgreementText('a\nb'));
    });

    it('does NOT normalise anything else', () => {
      // A "helpful" trim is how a stored hash stops matching its stored text.
      expect(hashAgreementText(' a ')).not.toBe(hashAgreementText('a'));
    });

    it('rejects a tampered hash', () => {
      expect(verifyAgreementHash('1.0.0', 'deadbeef')).toBe(false);
    });
  });

  describe('content', () => {
    const body = getCurrentAgreement().body;

    it('covers the obligations the product actually enforces', () => {
      // If the code does something the agreement does not describe, the
      // agreement is not the thing the VA consented to.
      expect(body).toMatch(/one site at a time/i);
      expect(body).toMatch(/recorded: which site, which\nassistant, when/i);
      expect(body).toMatch(/revoke your access at any moment/i);
    });

    it('says obligations survive revocation', () => {
      expect(body).toMatch(/do not end with your access/i);
    });

    it('is written in plain language, not legalese', () => {
      // Signed by people applying for jobs, often not in their first language.
      expect(body).not.toMatch(/\bhereinafter\b|\bwhereas\b|\bheretofore\b/i);
    });
  });
});
