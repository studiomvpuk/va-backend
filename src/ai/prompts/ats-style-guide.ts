/**
 * The shared output standard, baked into every drafting prompt.
 *
 * PRD §5.5: "This is enforced via a shared style + ATS guide baked into every
 * drafting prompt, not left to either model's default voice."
 *
 * That sentence is the reason this is one exported constant rather than a
 * paragraph copy-pasted into each call site. Two copies drift; when they drift,
 * Claude and GPT start producing differently-shaped output, and the §5.5a
 * orchestration rule stops being a routing decision and becomes a coin flip.
 */
export const ATS_STYLE_GUIDE = `
You are writing job application material that must pass automated Applicant
Tracking System screening and then be read by a human recruiter. Those are the
only two audiences. Write for them.

STRUCTURE
- Use plain, standard section headers: Experience, Education, Skills.
- No tables, no columns, no text boxes, no graphics, no headers or footers.
  ATS parsers read these as garbage or drop them entirely.
- Standard bullet points. One achievement per bullet.
- Dates as "Month Year - Month Year". Spell out the month.

LANGUAGE
- Plain, direct, human. Short sentences. Active voice.
- Mirror the exact terminology the job description uses. If it says "stakeholder
  management", write "stakeholder management", not "working with partners".
  The parser is matching strings, not meaning.
- Quantify where the source material supports it. Never invent a number.

NEVER WRITE
- Filler openers or closers: "I hope this helps", "I am excited to apply",
  "Thank you for considering my application", "I would welcome the opportunity".
- Hedging: "I believe I may be", "I feel that I could potentially".
- Generic platitudes: "team player", "hard worker", "passionate about",
  "detail-oriented", "results-driven", "go-getter", "think outside the box".
- Anything that reads as written by a language model rather than by the person.

TRUTH
- Every claim must trace to something in the candidate's own profile.
- Reframing real experience for a different audience is the job. Inventing
  experience is not, and is worse than a weaker application.
`.trim();

/**
 * Phrases that must not survive into delivered output.
 *
 * A second line of defence rather than the first: the prompt above is what
 * should prevent these. This catches the cases where it did not, because "the
 * model was told not to" is not a guarantee, and a VA pasting "I hope this
 * helps!" into a real application is a visible failure.
 */
export const FILLER_BLOCKLIST: readonly RegExp[] = [
  /\bI hope (?:this|that) helps\b/i,
  /\bthank you for (?:considering|your time)\b/i,
  /\bI would welcome the opportunity\b/i,
  /\bI am (?:very )?excited to (?:apply|be applying)\b/i,
  /\bI believe I (?:may|might|could) be\b/i,
  /\bteam player\b/i,
  /\bhard[- ]working individual\b/i,
  /\bpassionate about\b/i,
  /\bresults[- ]driven\b/i,
  /\bdetail[- ]oriented\b/i,
  /\bthink outside the box\b/i,
  /\bhit the ground running\b/i,
  /\bwears many hats\b/i,
  /\bas an AI\b/i,
  /\bhere(?:'s| is) (?:a|the) draft\b/i,
  /\bfeel free to\b/i,
];

export interface FillerFinding {
  phrase: string;
  index: number;
}

/** Finds blocklisted phrases. Returns every hit so a caller can report all of them. */
export function findFiller(text: string): FillerFinding[] {
  const findings: FillerFinding[] = [];
  for (const pattern of FILLER_BLOCKLIST) {
    const match = pattern.exec(text);
    if (match) findings.push({ phrase: match[0], index: match.index });
  }
  return findings.sort((a, b) => a.index - b.index);
}

/**
 * Strips filler and tidies the seams.
 *
 * Used as a last pass before output reaches a VA. Removing a phrase can leave a
 * double space or a stranded sentence fragment, so the whitespace cleanup is
 * part of the operation rather than an afterthought.
 */
export function stripFiller(text: string): string {
  let out = text;
  for (const pattern of FILLER_BLOCKLIST) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'), '');
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])\s*\1+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}
