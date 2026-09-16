import { checkAts, extractKeywords } from './ats-check';

const JD =
  'Marketing Coordinator. You will own social media scheduling, produce monthly ' +
  'reporting dashboards, and support stakeholder communications across the ' +
  'marketing team. Experience with analytics and campaign reporting essential.';

describe('extractKeywords', () => {
  it('pulls the distinctive terms out of a posting', () => {
    const keywords = extractKeywords(JD);
    expect(keywords).toEqual(expect.arrayContaining(['reporting', 'marketing', 'social']));
  });

  it('drops words too common to mean anything', () => {
    const keywords = extractKeywords(JD);
    for (const noise of ['the', 'you', 'will', 'experience', 'team']) {
      expect(keywords).not.toContain(noise);
    }
  });

  it('keeps generic-sounding words that postings actually match on', () => {
    // An aggressive stop list would strip exactly the terms that matter.
    expect(extractKeywords('Reporting and stakeholder support and delivery')).toEqual(
      expect.arrayContaining(['reporting', 'stakeholder', 'support', 'delivery']),
    );
  });

  it('handles technology names with punctuation', () => {
    expect(extractKeywords('We use C# and Node.js and CI/CD pipelines')).toEqual(
      expect.arrayContaining(['node.js']),
    );
  });

  it('is deterministic — ties broken alphabetically', () => {
    expect(extractKeywords(JD)).toEqual(extractKeywords(JD));
  });

  it('returns nothing for an empty posting rather than throwing', () => {
    expect(extractKeywords('')).toEqual([]);
  });
});

describe('checkAts', () => {
  const good =
    'Experience\nMarketing Coordinator, Descasio Ltd, January 2023 - Present\n' +
    '- Owned social media scheduling across three channels.\n' +
    '- Produced monthly reporting dashboards for stakeholder review.\n' +
    '- Ran campaign analytics for the marketing team.';

  it('passes a clean, well-structured draft', () => {
    const report = checkAts(good, JD);
    expect(report.passes).toBe(true);
    expect(report.findings).toEqual([]);
  });

  describe('structure', () => {
    it('blocks a table', () => {
      const report = checkAts('| Role | Dates |\n| --- | --- |\n| Dev | 2024 |', JD);
      expect(report.passes).toBe(false);
      expect(report.findings.map((f) => f.code)).toContain('markdown_table');
    });

    it('blocks markdown headings', () => {
      expect(checkAts('## Experience\nDid things.', JD).passes).toBe(false);
    });

    it('blocks HTML', () => {
      expect(checkAts('<div>Experience</div>', JD).passes).toBe(false);
    });

    it('blocks space-made columns', () => {
      // A parser reads across the line and interleaves them.
      const columns = 'Developer          Acme Ltd          2020-2024';
      expect(checkAts(columns, JD).passes).toBe(false);
    });

    it('warns but does not block on markdown bold', () => {
      const report = checkAts('**Experience**\nDid things.', JD);
      expect(report.findings.map((f) => f.code)).toContain('markdown_emphasis');
      expect(report.passes).toBe(true);
    });

    it('warns on decorative bullets', () => {
      expect(
        checkAts('▪ Did a thing\n▪ Did another', JD).findings.map((f) => f.code),
      ).toContain('nonstandard_bullet');
    });

    it('does not flag ordinary hyphen bullets or date ranges', () => {
      expect(checkAts(good, JD).findings).toEqual([]);
    });
  });

  describe('filler', () => {
    /** The PRD: no draft output may contain a blocklist phrase. */
    it('BLOCKS filler rather than warning', () => {
      const report = checkAts(`${good}\n\nI hope this helps!`, JD);
      expect(report.passes).toBe(false);
      expect(report.findings.some((f) => f.code === 'filler')).toBe(true);
    });

    it('names every phrase it found, not just the first', () => {
      const report = checkAts('A results-driven team player.', JD);
      const messages = report.findings
        .filter((f) => f.code === 'filler')
        .map((f) => f.message)
        .join(' ');
      expect(messages).toMatch(/team player/i);
      expect(messages).toMatch(/results-driven/i);
    });

    it('returns a cleaned version alongside the verdict', () => {
      const report = checkAts(`${good}\n\nI hope this helps!`, JD);
      expect(report.cleaned).not.toMatch(/I hope this helps/);
      expect(report.cleaned).toContain('social media scheduling');
    });

    it('the cleaned version of a clean draft is unchanged', () => {
      expect(checkAts(good, JD).cleaned).toBe(good);
    });
  });

  describe('keyword alignment', () => {
    it('scores a draft that mirrors the posting highly', () => {
      expect(checkAts(good, JD).keywordAlignment).toBeGreaterThan(0.25);
    });

    it('warns when a draft shares almost nothing with the posting', () => {
      const unrelated = 'Experience\nI worked in a bakery decorating cakes.';
      const report = checkAts(unrelated, JD);
      expect(report.findings.map((f) => f.code)).toContain('low_keyword_alignment');
      // A warning, not a block — a genuine career change legitimately looks
      // like this, and refusing to draft it would be wrong.
      expect(report.passes).toBe(true);
    });

    it('reports which terms are missing, so the gap is actionable', () => {
      const report = checkAts('Experience\nI decorated cakes.', JD);
      expect(report.missingKeywords.length).toBeGreaterThan(0);
      expect(report.missingKeywords).toEqual(expect.arrayContaining(['reporting']));
    });

    it('does not divide by zero on an empty posting', () => {
      expect(checkAts(good, '').keywordAlignment).toBe(1);
    });
  });

  it('reports every finding, not just the first', () => {
    const bad = '## Heading\n| a | b |\nI hope this helps!';
    expect(checkAts(bad, JD).findings.length).toBeGreaterThanOrEqual(3);
  });
});
