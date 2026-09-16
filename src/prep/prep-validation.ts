/**
 * Throwing away everything the model could not account for.
 *
 * PRD Phase 8 acceptance: "Every talking point traces to a real profile field
 * or a cited source; a job with no findable company information degrades to
 * questions and talking points rather than fabricating background."
 *
 * The model is asked to cite its basis for each claim. This is where those
 * citations are checked against what actually exists — the field keys the
 * Client really has, and the URLs the search really returned. Same shape as the
 * disclosure path: the model proposes, code decides, and the model's own
 * account of itself is never taken as evidence.
 *
 * ── Drop, do not soften ─────────────────────────────────────────────────────
 * An unverifiable talking point is removed, not hedged into "you might mention".
 * A hedged invention is still an invention, and the candidate is reading this
 * the night before rather than auditing it.
 */

export interface ProfileBasis {
  kind: 'profile_field';
  key: string;
}
export interface NarrativeBasis {
  kind: 'narrative';
}
export interface SourceBasis {
  kind: 'source';
  url: string;
}
export type TalkingPointBasis = ProfileBasis | NarrativeBasis | SourceBasis;

export interface ProposedTalkingPoint {
  point: string;
  basis: unknown;
}

export interface PrepProposal {
  background: string | null;
  backgroundSourceUrls: string[];
  questions: { question: string; why: string }[];
  talkingPoints: ProposedTalkingPoint[];
}

/** What the claims are checked against. Nothing here comes from the model. */
export interface Evidence {
  /** Keys of profile fields this Client actually has. */
  profileFieldKeys: Set<string>;
  /** Whether an experience narrative exists at all. */
  hasNarrative: boolean;
  /** URLs the search provider actually returned. */
  sourceUrls: Set<string>;
}

export interface TalkingPoint {
  point: string;
  basis: TalkingPointBasis;
}

export interface ValidatedPrep {
  background: string | null;
  sources: string[];
  questions: { question: string; why: string }[];
  talkingPoints: TalkingPoint[];
  /** What was discarded and why — surfaced in logs, not to the Client. */
  discarded: string[];
}

const MAX_QUESTIONS = 10;
const MAX_TALKING_POINTS = 8;

export function validatePrep(proposal: PrepProposal, evidence: Evidence): ValidatedPrep {
  const discarded: string[] = [];

  const sources = (proposal.backgroundSourceUrls ?? []).filter((url) => {
    const known = evidence.sourceUrls.has(url);
    if (!known) discarded.push(`background source not in search results: ${url}`);
    return known;
  });

  // Background survives only if it is attributed. A paragraph citing nothing is
  // the model writing from memory, which is the exact failure this guards.
  const background =
    typeof proposal.background === 'string' && proposal.background.trim().length > 0
      ? proposal.background.trim()
      : null;

  const attributedBackground = background !== null && sources.length > 0 ? background : null;
  if (background !== null && attributedBackground === null) {
    discarded.push('background had no verifiable source');
  }

  const talkingPoints: TalkingPoint[] = [];
  for (const proposed of proposal.talkingPoints ?? []) {
    if (typeof proposed?.point !== 'string' || proposed.point.trim().length === 0) continue;

    const basis = resolveBasis(proposed.basis, evidence);
    if (!basis) {
      discarded.push(`talking point unattributable: ${proposed.point.slice(0, 60)}`);
      continue;
    }
    talkingPoints.push({ point: proposed.point.trim(), basis });
    if (talkingPoints.length === MAX_TALKING_POINTS) break;
  }

  const questions = (proposal.questions ?? [])
    .filter(
      (q) => typeof q?.question === 'string' && q.question.trim().length > 0,
    )
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({
      question: q.question.trim(),
      why: typeof q.why === 'string' ? q.why.trim() : '',
    }));

  return {
    background: attributedBackground,
    // Sources are only meaningful alongside the text they support.
    sources: attributedBackground === null ? [] : unique(sources),
    questions,
    talkingPoints,
    discarded,
  };
}

function resolveBasis(raw: unknown, evidence: Evidence): TalkingPointBasis | null {
  const basis = raw as { kind?: unknown; key?: unknown; url?: unknown };

  if (basis?.kind === 'profile_field') {
    // The key has to be one this Client actually has. A plausible key for a
    // field they never filled in is the most convincing kind of fabrication.
    return typeof basis.key === 'string' && evidence.profileFieldKeys.has(basis.key)
      ? { kind: 'profile_field', key: basis.key }
      : null;
  }

  if (basis?.kind === 'narrative') {
    return evidence.hasNarrative ? { kind: 'narrative' } : null;
  }

  if (basis?.kind === 'source') {
    return typeof basis.url === 'string' && evidence.sourceUrls.has(basis.url)
      ? { kind: 'source', url: basis.url }
      : null;
  }

  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Is there enough here to be worth showing?
 *
 * Questions alone are worth reading — they are derived from the posting, which
 * is always available — so a document with no background and no talking points
 * is still useful. A document with nothing at all is a failure, and saying so
 * is better than presenting an empty page as a result.
 */
export function isWorthShowing(prep: ValidatedPrep): boolean {
  return prep.questions.length > 0 || prep.talkingPoints.length > 0;
}
