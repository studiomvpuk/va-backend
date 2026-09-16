import {
  analysePosting,
  calibrate,
  candidateLevelFromYears,
  extractYearsRequested,
  levelFromYears,
} from './seniority';

describe('extracting years requested', () => {
  it.each([
    ['3+ years of commercial experience', 3],
    ['5-7 years in a similar role', 5],
    ['5 – 7 years', 5],
    ['at least 2 years experience', 2],
    ['minimum of 4 years', 4],
    ['Minimum 6 years professional experience', 6],
    ['at least three years', 3],
    ['2 years of relevant experience', 2],
  ])('reads %s as %i', (text, expected) => {
    expect(extractYearsRequested(text)).toBe(expected);
  });

  it.each([
    'We have been trading for 30 years',
    'A 12 month fixed term contract',
    'Founded in 2011',
    'Salary 45000',
  ])('does not invent a figure from %s', (text) => {
    // These are the false positives that would silently mis-level a posting.
    expect(extractYearsRequested(text)).toBeNull();
  });

  it('returns null when nothing is stated', () => {
    expect(extractYearsRequested('We are looking for a developer.')).toBeNull();
  });
});

describe('years to level', () => {
  it.each([
    [0, 'entry'],
    [1, 'junior'],
    [2, 'junior'],
    [4, 'mid'],
    [5, 'mid'],
    [7, 'senior'],
    [8, 'senior'],
    [12, 'lead'],
  ] as const)('%i years reads as %s', (years, level) => {
    expect(levelFromYears(years)).toBe(level);
  });
});

describe('analysing a posting', () => {
  const posting = (title: string, description = '') => analysePosting({ title, description });

  describe('title signals', () => {
    it.each([
      ['Junior Frontend Developer', 'junior'],
      ['Graduate Software Engineer', 'entry'],
      ['Software Engineering Intern', 'entry'],
      ['Senior Backend Engineer', 'senior'],
      ['Sr. Product Designer', 'senior'],
      ['Lead Platform Engineer', 'lead'],
      ['Principal Engineer', 'lead'],
      ['Head of Engineering', 'lead'],
      ['Associate Developer', 'junior'],
      ['Mid-level Developer', 'mid'],
    ] as const)('%s reads as %s', (title, level) => {
      expect(posting(title).level).toBe(level);
    });

    it('is confident when the title is explicit', () => {
      expect(posting('Senior Backend Engineer').confidence).toBe('high');
    });
  });

  /**
   * The case that matters most: a badly written posting.
   */
  it('trusts the title over a contradictory years figure', () => {
    const reading = posting('Junior Developer', 'You will need 6+ years of experience.');
    // Applying as a senior to something labelled junior is the exact failure
    // §5.5b describes, so the label wins.
    expect(reading.level).toBe('junior');
    expect(reading.confidence).toBe('medium');
    expect(reading.yearsRequested).toBe(6);
  });

  it('falls back to years when the title is generic', () => {
    const reading = posting('Developer', 'We need 7+ years of commercial experience.');
    expect(reading.level).toBe('senior');
    expect(reading.confidence).toBe('medium');
  });

  it('falls back to responsibility language when there are no years', () => {
    const reading = posting(
      'Software Engineer',
      'You will mentor the team, own the roadmap and set technical direction.',
    );
    expect(reading.level).toBe('lead');
  });

  it('reads training language as entry level', () => {
    const reading = posting(
      'Customer Support Representative',
      'Full training provided. We are keen to hear from people eager to learn.',
    );
    expect(reading.level).toBe('entry');
  });

  it('reports low confidence when there is nothing to go on', () => {
    const reading = posting('Developer', 'Join our team. Great culture. Free coffee.');
    // Low confidence is the signal for the caller to ask a model rather than
    // proceeding on a guess.
    expect(reading.confidence).toBe('low');
  });

  it('always explains itself', () => {
    expect(posting('Senior Engineer').evidence.length).toBeGreaterThan(0);
  });
});

describe('calibration', () => {
  it('reports MATCHED when the levels agree', () => {
    const result = calibrate('mid', 'mid');
    expect(result.verdict).toBe('MATCHED');
    expect(result.distance).toBe(0);
    expect(result.directive).toMatch(/no reframing/i);
  });

  describe('over-levelled — the expensive case', () => {
    const result = calibrate('junior', 'lead');

    it('is detected', () => {
      expect(result.verdict).toBe('OVER_LEVELLED');
      expect(result.distance).toBe(3);
    });

    it('tells the drafter to drop scope, years and leadership', () => {
      expect(result.directive).toMatch(/de-emphasise or drop leadership scope/i);
      expect(result.directive).toMatch(/total years/i);
    });

    it('tells it to change emphasis, not truth', () => {
      // This is the line between reframing and lying, and it has to be in the
      // prompt rather than assumed.
      expect(result.directive).toMatch(/change emphasis, not truth/i);
      expect(result.directive).toMatch(/do not invent or remove facts/i);
    });

    it('explains to the Client WHY, not just that', () => {
      expect(result.explanation).toMatch(/flight risk|salary mismatch/i);
    });
  });

  describe('under-levelled', () => {
    const result = calibrate('senior', 'junior');

    it('is detected', () => {
      expect(result.verdict).toBe('UNDER_LEVELLED');
      expect(result.distance).toBe(-2);
    });

    it('tells the drafter to lead with their most senior real work', () => {
      expect(result.directive).toMatch(/foreground the most senior-sounding/i);
      expect(result.directive).toMatch(/close the gap rather than underselling/i);
    });

    it('still forbids claiming experience they lack', () => {
      expect(result.directive).toMatch(/do not claim experience they do not have/i);
    });
  });

  it('is symmetric in distance', () => {
    expect(calibrate('entry', 'senior').distance).toBe(3);
    expect(calibrate('senior', 'entry').distance).toBe(-3);
  });

  it('derives a candidate level from total years', () => {
    expect(candidateLevelFromYears(4)).toBe('mid');
    expect(candidateLevelFromYears(15)).toBe('lead');
  });
});

/**
 * The fixture set from the PRD's Phase 6 acceptance criteria: ten real-shaped
 * postings across the range.
 */
describe('fixture set — ten postings', () => {
  const FIXTURES: {
    title: string;
    description: string;
    expected: string;
  }[] = [
    {
      title: 'Marketing Coordinator',
      description: '1-2 years experience, social media and reporting.',
      expected: 'junior',
    },
    {
      title: 'Graduate Software Engineer',
      description: 'Our two-year graduate programme. Full training provided.',
      expected: 'entry',
    },
    {
      title: 'Admin Assistant',
      description: 'Supporting the team with scheduling. Training provided.',
      expected: 'entry',
    },
    {
      title: 'Full-stack Developer',
      description: 'You will need at least 4 years of commercial experience.',
      expected: 'mid',
    },
    {
      title: 'Senior React Developer',
      description: '5+ years. You will own architecture decisions.',
      expected: 'senior',
    },
    {
      title: 'Lead Engineer',
      description: 'Line manage three engineers and set technical direction.',
      expected: 'lead',
    },
    {
      title: 'Head of Product',
      description: 'Own the roadmap across three squads.',
      expected: 'lead',
    },
    {
      title: 'Junior Data Analyst',
      description: 'SQL and Excel. Supported by a senior analyst.',
      expected: 'junior',
    },
    {
      title: 'Support Representative',
      description: 'Handle customer queries. Full training provided, eager to learn.',
      expected: 'entry',
    },
    {
      title: 'Software Engineer',
      description: 'Minimum of 7 years professional experience required.',
      expected: 'senior',
    },
  ];

  it.each(FIXTURES)('$title reads as $expected', ({ title, description, expected }) => {
    expect(analysePosting({ title, description }).level).toBe(expected);
  });

  it('none of them fall through to a low-confidence guess', () => {
    for (const fixture of FIXTURES) {
      expect(analysePosting(fixture).confidence).not.toBe('low');
    }
  });

  /**
   * The scenario from the PRD: a senior candidate applying to a junior posting.
   */
  it('a 12-year candidate against the Marketing Coordinator role is over-levelled', () => {
    const posting = analysePosting(FIXTURES[0]);
    const result = calibrate(posting.level, candidateLevelFromYears(12));

    expect(result.verdict).toBe('OVER_LEVELLED');
    expect(result.directive).toMatch(/drop leadership scope/i);
  });
});
