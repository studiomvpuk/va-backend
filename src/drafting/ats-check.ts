import { findFiller, stripFiller } from '../ai/prompts/ats-style-guide';

/**
 * The single quality bar (PRD §5.5).
 *
 * "Every output judged against one bar: will this parse correctly in an
 *  Applicant Tracking System and match the job description's keywords — not
 *  which model's writing style is preferred."
 *
 * So this checks two things and neither is taste: does the structure survive a
 * parser, and does the language overlap the posting's own terminology.
 */

export type AtsSeverity = 'blocking' | 'warning';

export interface AtsFinding {
  severity: AtsSeverity;
  code: string;
  message: string;
}

export interface AtsReport {
  /** No blocking findings. Warnings are worth showing, not worth stopping for. */
  passes: boolean;
  findings: AtsFinding[];
  /** Fraction of the posting's distinctive terms that appear in the draft, 0–1. */
  keywordAlignment: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  /** The draft with filler removed. */
  cleaned: string;
}

/* ── Structural hazards ─────────────────────────────────────────────────────
 * Each of these is something an ATS parser mangles or drops outright. */
const STRUCTURE_CHECKS: {
  code: string;
  severity: AtsSeverity;
  pattern: RegExp;
  message: string;
}[] = [
  {
    code: 'markdown_table',
    severity: 'blocking',
    pattern: /^\s*\|.*\|\s*$/m,
    message: 'Contains a table. ATS parsers read tables as scrambled text or drop them.',
  },
  {
    code: 'markdown_heading',
    severity: 'blocking',
    pattern: /^#{1,6}\s/m,
    message:
      'Contains markdown headings. Paste targets are plain-text boxes — write ' +
      'section names as plain words.',
  },
  {
    code: 'markdown_emphasis',
    severity: 'warning',
    pattern: /\*\*[^*]+\*\*|__[^_]+__/,
    message: 'Contains markdown bold, which shows up literally as asterisks.',
  },
  {
    code: 'html',
    severity: 'blocking',
    pattern: /<\/?(?:div|span|table|tr|td|br|p|b|i|ul|li)\b[^>]*>/i,
    message: 'Contains HTML tags.',
  },
  {
    code: 'multi_column',
    severity: 'blocking',
    pattern: /\S {6,}\S.* {6,}\S/,
    message:
      'Looks like columns made with spaces. A parser reads across the line and ' +
      'interleaves them.',
  },
  {
    code: 'nonstandard_bullet',
    severity: 'warning',
    pattern: /^\s*[▪▸►‣✦✧◆]/m,
    message: 'Uses decorative bullet characters, which can come through as mojibake.',
  },
];

/**
 * Words too common to indicate anything.
 *
 * Kept deliberately short. An aggressive stop list would strip the terms that
 * matter — "support", "delivery", "reporting" are generic English AND exactly
 * what a posting is matching on.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'our', 'with', 'will', 'are', 'this', 'that',
  'have', 'from', 'your', 'their', 'they', 'them', 'has', 'was', 'were', 'been',
  'all', 'any', 'can', 'who', 'what', 'when', 'where', 'how', 'why', 'not',
  'but', 'out', 'about', 'into', 'over', 'also', 'more', 'most', 'some', 'such',
  'role', 'work', 'working', 'team', 'join', 'looking', 'apply', 'candidate',
  'company', 'business', 'opportunity', 'experience', 'years', 'good', 'great',
  'able', 'well', 'within', 'across', 'per', 'via', 'including', 'etc',
]);

/** Distinctive terms from a posting, most frequent first. */
export function extractKeywords(jobDescription: string, limit = 25): string[] {
  const counts = new Map<string, number>();

  for (const raw of jobDescription.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) {
    const word = raw.replace(/[.]+$/, '');
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

export function checkAts(draft: string, jobDescription: string): AtsReport {
  const findings: AtsFinding[] = [];

  for (const check of STRUCTURE_CHECKS) {
    if (check.pattern.test(draft)) {
      findings.push({
        severity: check.severity,
        code: check.code,
        message: check.message,
      });
    }
  }

  // Filler is blocking. The PRD is explicit that "I hope this helps!" must not
  // survive, and a VA pasting it into a real application is a visible failure.
  for (const filler of findFiller(draft)) {
    findings.push({
      severity: 'blocking',
      code: 'filler',
      message: `Contains filler: "${filler.phrase}".`,
    });
  }

  const keywords = extractKeywords(jobDescription);
  const lowerDraft = draft.toLowerCase();
  const matched = keywords.filter((k) => lowerDraft.includes(k));
  const missing = keywords.filter((k) => !lowerDraft.includes(k));

  const alignment = keywords.length === 0 ? 1 : matched.length / keywords.length;
  if (keywords.length > 0 && alignment < 0.25) {
    findings.push({
      severity: 'warning',
      code: 'low_keyword_alignment',
      message:
        `Only ${Math.round(alignment * 100)}% of the posting's distinctive terms ` +
        `appear in this draft. ATS screening matches strings, so mirroring the ` +
        `posting's own wording matters.`,
    });
  }

  return {
    passes: !findings.some((f) => f.severity === 'blocking'),
    findings,
    keywordAlignment: Math.round(alignment * 100) / 100,
    matchedKeywords: matched,
    missingKeywords: missing.slice(0, 10),
    cleaned: stripFiller(draft),
  };
}
