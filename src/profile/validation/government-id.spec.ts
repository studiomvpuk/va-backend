import {
  detectGovernmentId,
  isValidNhsNumber,
  isPlausibleSsn,
  governmentIdRejectionMessage,
} from './government-id';

describe('government ID detection', () => {
  describe('UK National Insurance', () => {
    it.each([
      'AB123456C',
      'AB 12 34 56 C',
      'ab123456c',
      'JM234567',
      'My NI number is PR 65 43 21 A',
    ])('rejects %s', (value) => {
      expect(detectGovernmentId(value)?.kind).toBe('uk_national_insurance');
    });

    it.each(['BG123456C', 'GB123456A', 'NK123456B', 'ZZ123456D'])(
      'ignores the reserved prefix %s',
      (value) => {
        expect(detectGovernmentId(value)?.kind).not.toBe('uk_national_insurance');
      },
    );

    it.each(['DA123456C', 'AO123456C', 'QQ123456C'])(
      'ignores %s — those letters are not issued',
      (value) => {
        expect(detectGovernmentId(value)?.kind).not.toBe('uk_national_insurance');
      },
    );
  });

  describe('NHS number', () => {
    it('validates the modulus-11 check digit', () => {
      expect(isValidNhsNumber('9434765919')).toBe(true); // NHS Digital's example
      expect(isValidNhsNumber('9434765918')).toBe(false);
      expect(isValidNhsNumber('123456789')).toBe(false);
    });

    it('rejects a number whose check digit would be 10', () => {
      expect(isValidNhsNumber('0000000010')).toBe(false);
    });

    it('detects it in the conventional grouping', () => {
      expect(detectGovernmentId('943 476 5919')?.kind).toBe('uk_nhs_number');
    });

    it('detects an ungrouped one when NHS is mentioned', () => {
      expect(detectGovernmentId('9434765919', 'NHS number')?.kind).toBe('uk_nhs_number');
    });

    it('ignores an ungrouped ten-digit number with no context', () => {
      // Could be anything — a phone number, a reference. Not enough to act on.
      expect(detectGovernmentId('9434765919')).toBeNull();
    });
  });

  describe('US Social Security', () => {
    it('detects the dashed form', () => {
      expect(detectGovernmentId('123-45-6789')?.kind).toBe('us_social_security');
    });

    it('applies the SSA structural rules', () => {
      expect(isPlausibleSsn('000', '45', '6789')).toBe(false);
      expect(isPlausibleSsn('666', '45', '6789')).toBe(false);
      expect(isPlausibleSsn('900', '45', '6789')).toBe(false);
      expect(isPlausibleSsn('123', '00', '6789')).toBe(false);
      expect(isPlausibleSsn('123', '45', '0000')).toBe(false);
      expect(isPlausibleSsn('123', '45', '6789')).toBe(true);
    });

    it('detects an undashed one when a keyword is present', () => {
      expect(detectGovernmentId('123456789', 'SSN')?.kind).toBe('us_social_security');
      expect(detectGovernmentId('My social security is 123456789')?.kind).toBe(
        'us_social_security',
      );
    });

    it('ignores a bare nine-digit number', () => {
      expect(detectGovernmentId('123456789')).toBeNull();
    });
  });

  describe('passport', () => {
    it('detects a keyword-labelled number', () => {
      expect(detectGovernmentId('Passport No: 123456789')?.kind).toBe('passport_number');
    });

    it('ignores an unlabelled alphanumeric run', () => {
      expect(detectGovernmentId('AB1234567')?.kind).not.toBe('passport_number');
    });
  });

  /**
   * The half of this that matters as much as the detection: a CV is full of
   * digit strings, and refusing to save something legitimate is a real harm,
   * not a neutral safe default.
   */
  describe('false positives — ordinary CV and profile content', () => {
    it.each([
      'Manchester, M1 4BT',
      '+44 7700 900123',
      '07700 900123',
      'Employed 2019-2024 at MTN Group',
      'Increased conversion by 34% over 6 months',
      'Reference: INV-2024-000841',
      'Order 123456789 processed',
      'Salary expectation: 55000',
      'BSc Mathematics, 2:1, Federal University Oye-Ekiti',
      'Managed a team of 12 across 3 sites',
      'olonts@gmail.com',
      'github.com/olont/project-2024',
      'Sort code 20-45-45',
      'Available from 01-09-2026',
      'Grade A*A*A at A-level',
    ])('accepts %s', (value) => {
      expect(detectGovernmentId(value)).toBeNull();
    });

    it('accepts a realistic CV paragraph', () => {
      const cv =
        'Full-stack developer with 4+ years commercial experience. Built and shipped ' +
        '12 client products at StudioMVP (studiomvp.co.uk), 2022-2026. Previously at ' +
        'MTN Group. Reduced p95 latency from 1200ms to 180ms. Manchester, UK. ' +
        'Contact 07700 900123.';
      expect(detectGovernmentId(cv)).toBeNull();
    });
  });

  describe('the rejection message', () => {
    it('names what was found and why, without echoing the value', () => {
      const match = detectGovernmentId('AB123456C')!;
      const message = governmentIdRejectionMessage(match);
      expect(message).toContain('National Insurance');
      expect(message).not.toContain('AB123456C');
      // The message has to explain the "even marked as sensitive" part, or it
      // reads as a bug rather than a policy.
      expect(message).toMatch(/even marked as sensitive/i);
    });
  });

  it('returns null for empty input rather than throwing', () => {
    expect(detectGovernmentId('')).toBeNull();
  });
});
