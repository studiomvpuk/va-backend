/**
 * Reading a job posting's actual seniority (PRD §5.5b).
 *
 * The problem this exists for, in the PRD's words: "a CV that reads as
 * overqualified gets rejected almost as often as one that reads as
 * underqualified — screeners see 10+ years of senior/leadership experience
 * applied to a junior or general role and assume a flight risk or a salary
 * mismatch, regardless of how good the candidate is."
 *
 * ── Why this is mostly not a model call ──────────────────────────────────────
 * "Senior Engineer, 5+ years" is not a judgement call, it is two strings and a
 * number. Deterministic extraction is faster, free, reproducible, and cannot be
 * talked out of its answer by text inside the posting — which matters, because
 * the posting is attacker-controllable input. The model is a fallback for the
 * genuinely ambiguous minority, and its answer is bounded by the same scale.
 */

export type SeniorityLevel = 'entry' | 'junior' | 'mid' | 'senior' | 'lead';

export const LEVEL_ORDER: SeniorityLevel[] = ['entry', 'junior', 'mid', 'senior', 'lead'];

export function levelIndex(level: SeniorityLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export interface SeniorityReading {
  level: SeniorityLevel;
  /** How much to trust it. `low` is the signal to ask a model. */
  confidence: 'high' | 'medium' | 'low';
  /** What drove it, for the fit reasoning the Client reads. */
  evidence: string[];
  yearsRequested: number | null;
}

/* ── Title signals ──────────────────────────────────────────────────────────
 * Ordered most-specific first: "senior graduate scheme" should not read as
 * senior, and "lead" inside "team lead" should outrank a bare "engineer". */
const TITLE_SIGNALS: { pattern: RegExp; level: SeniorityLevel; weight: number }[] = [
  { pattern: /\b(intern|internship|placement|work experience)\b/i, level: 'entry', weight: 3 },
  { pattern: /\b(graduate|grad scheme|trainee|apprentice|entry[- ]level|no experience)\b/i, level: 'entry', weight: 3 },
  { pattern: /\b(junior|jr\.?|associate)\b/i, level: 'junior', weight: 3 },
  { pattern: /\b(head of|director of|vp of|vice president|chief)\b/i, level: 'lead', weight: 3 },
  { pattern: /\b(principal|staff|lead|team lead|tech lead)\b/i, level: 'lead', weight: 3 },
  { pattern: /\b(senior|snr\.?|sr\.?)\b/i, level: 'senior', weight: 3 },
  { pattern: /\b(mid[- ]level|intermediate)\b/i, level: 'mid', weight: 2 },
];

/* ── Responsibility language ────────────────────────────────────────────────
 * Weaker than a title but useful when the title is generic ("Developer"). */
const LANGUAGE_SIGNALS: { pattern: RegExp; level: SeniorityLevel; weight: number }[] = [
  { pattern: /\b(mentor|mentoring|line manage|manage a team|own the roadmap|set (?:the )?technical direction|hiring)\b/i, level: 'lead', weight: 2 },
  { pattern: /\b(architect|architecture decisions|technical strategy|cross[- ]functional leadership)\b/i, level: 'senior', weight: 2 },
  { pattern: /\b(work independently|own(?:s|ing)? features end[- ]to[- ]end|lead small projects)\b/i, level: 'mid', weight: 1 },
  { pattern: /\b(under supervision|with guidance|supported by|learn(?:ing)? on the job|full training|training provided)\b/i, level: 'entry', weight: 2 },
  { pattern: /\b(eager to learn|keen to learn|first role|start your career)\b/i, level: 'entry', weight: 2 },
];

/** "3+ years", "5-7 years", "at least two years", "minimum of 4 years". */
const YEARS_PATTERNS: RegExp[] = [
  /\b(\d{1,2})\s*\+?\s*(?:-|–|to)\s*\d{1,2}\s*years?\b/i,
  /\b(?:at least|minimum(?: of)?|min\.?)\s*(\d{1,2})\s*years?\b/i,
  /\b(\d{1,2})\s*\+\s*years?\b/i,
  /\b(\d{1,2})\s*years?(?:\s+of)?\s+(?:commercial\s+|professional\s+|relevant\s+)?experience\b/i,
];

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export function extractYearsRequested(text: string): number | null {
  for (const pattern of YEARS_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  const worded = /\b(?:at least|minimum(?: of)?)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/i.exec(
    text,
  );
  if (worded) return WORD_NUMBERS[worded[1].toLowerCase()];
  return null;
}

export function levelFromYears(years: number): SeniorityLevel {
  if (years <= 0) return 'entry';
  if (years <= 2) return 'junior';
  if (years <= 5) return 'mid';
  if (years <= 8) return 'senior';
  return 'lead';
}

/**
 * Reads a posting.
 *
 * Title beats years beats language, because a posting that says "Junior
 * Developer, 5+ years experience" is a badly written junior role, not a senior
 * one — and applying as a senior to it is the exact failure §5.5b describes.
 */
export function analysePosting(input: {
  title: string;
  description: string;
}): SeniorityReading {
  const evidence: string[] = [];
  const titleHits = TITLE_SIGNALS.filter((s) => s.pattern.test(input.title));
  const years = extractYearsRequested(input.description) ?? extractYearsRequested(input.title);

  if (titleHits.length > 0) {
    const best = titleHits[0];
    evidence.push(`title says "${input.title.trim()}"`);
    if (years !== null) evidence.push(`${years} years requested`);
    return {
      level: best.level,
      // A title and a years figure that disagree means the posting is
      // inconsistent, which is worth flagging rather than hiding.
      confidence:
        years !== null && levelFromYears(years) !== best.level ? 'medium' : 'high',
      evidence,
      yearsRequested: years,
    };
  }

  if (years !== null) {
    evidence.push(`${years} years requested, no seniority in the title`);
    return { level: levelFromYears(years), confidence: 'medium', evidence, yearsRequested: years };
  }

  // Fall back to how the responsibilities are written.
  const scores = new Map<SeniorityLevel, number>();
  for (const signal of LANGUAGE_SIGNALS) {
    if (signal.pattern.test(input.description)) {
      scores.set(signal.level, (scores.get(signal.level) ?? 0) + signal.weight);
      evidence.push(`language suggests ${signal.level}`);
    }
  }

  if (scores.size === 0) {
    // Nothing to go on. `low` is the signal for the caller to ask a model.
    return {
      level: 'mid',
      confidence: 'low',
      evidence: ['no seniority signals in the title, years or language'],
      yearsRequested: null,
    };
  }

  const [level] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return { level, confidence: 'medium', evidence, yearsRequested: years };
}

// ── Calibration ─────────────────────────────────────────────────────────────

export type Calibration = 'UNDER_LEVELLED' | 'MATCHED' | 'OVER_LEVELLED';

export interface CalibrationResult {
  verdict: Calibration;
  postingLevel: SeniorityLevel;
  candidateLevel: SeniorityLevel;
  /** Steps apart on the scale. Drives how hard the reframing pushes. */
  distance: number;
  /** Goes verbatim into the drafting prompt. */
  directive: string;
  /** Goes into the fit reasoning the Client reads. */
  explanation: string;
}

export function calibrate(
  postingLevel: SeniorityLevel,
  candidateLevel: SeniorityLevel,
): CalibrationResult {
  const distance = levelIndex(candidateLevel) - levelIndex(postingLevel);

  if (distance === 0) {
    return {
      verdict: 'MATCHED',
      postingLevel,
      candidateLevel,
      distance,
      directive:
        'The candidate is at the level this role is pitched at. Present their ' +
        'experience straight — no reframing up or down.',
      explanation: 'Your experience matches the level this role is pitched at.',
    };
  }

  if (distance > 0) {
    return {
      verdict: 'OVER_LEVELLED',
      postingLevel,
      candidateLevel,
      distance,
      directive:
        `The candidate reads as ${candidateLevel} and this role is pitched at ` +
        `${postingLevel}. De-emphasise or drop leadership scope, strategic remit, ` +
        `team sizes and total years. Reframe the same real work at the level this ` +
        `role is asking for. Lead with hands-on delivery rather than direction-setting. ` +
        `Do not invent or remove facts — change emphasis, not truth.`,
      explanation:
        `You read as ${candidateLevel} for a ${postingLevel} role. Screeners ` +
        `often reject that as a flight risk or a salary mismatch, so the draft ` +
        `leads with hands-on work rather than scope.`,
    };
  }

  return {
    verdict: 'UNDER_LEVELLED',
    postingLevel,
    candidateLevel,
    distance,
    directive:
      `The candidate reads as ${candidateLevel} and this role is pitched at ` +
      `${postingLevel}. Foreground the most senior-sounding relevant achievements ` +
      `they genuinely have — ownership, scope, impact, anything they led. Close the ` +
      `gap rather than underselling. Do not claim experience they do not have.`,
    explanation:
      `This role is pitched above where you currently read (${candidateLevel} ` +
      `against ${postingLevel}), so the draft leads with your most senior work.`,
  };
}

/** The Client's own level, from total years of experience. */
export function candidateLevelFromYears(totalYears: number): SeniorityLevel {
  return levelFromYears(totalYears);
}
