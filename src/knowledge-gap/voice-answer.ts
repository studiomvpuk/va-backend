/**
 * Answering a knowledge gap by voice.
 *
 * PRD §5.6 / Phase 10: the Client is doing something else when the notification
 * arrives. Typing a paragraph about their notice period on a phone is the
 * friction that leaves the queue unanswered, and an unanswered queue is an
 * application sitting blocked.
 *
 * The transcription itself is `ITranscriber`, which has existed since Phase 4 —
 * this is the part around it: what audio is acceptable, and what to do with a
 * transcript that came back empty or unusable.
 */

export class VoiceAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceAnswerError';
  }
}

/** Whisper's own limit is 25MB; a spoken answer is seconds, not minutes. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * Accepted container formats.
 *
 * `audio/mp4` and `audio/webm` are what a browser's MediaRecorder produces on
 * Safari and Chrome respectively — between them that is every phone the Client
 * is likely to be holding. The rest are there for anything forwarded from a
 * messaging app: `audio/ogg` is what WhatsApp voice notes are.
 */
export const ACCEPTED_AUDIO = [
  'audio/mp4',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
] as const;

export type AudioMediaType = (typeof ACCEPTED_AUDIO)[number];

export function assertAcceptableAudio(input: { bytes: number; mediaType: string }): void {
  if (input.bytes === 0) throw new VoiceAnswerError('The recording was empty.');
  if (input.bytes > MAX_AUDIO_BYTES) {
    throw new VoiceAnswerError(
      'That recording is too long. A sentence or two is all this needs.',
    );
  }
  if (!ACCEPTED_AUDIO.includes(input.mediaType as AudioMediaType)) {
    throw new VoiceAnswerError(`Unsupported audio format: ${input.mediaType}`);
  }
}

/**
 * What a transcript has to clear to be treated as an answer.
 *
 * ── Why this is stricter than "not empty" ───────────────────────────────────
 * A transcriber given silence, a pocket recording, or a room with a television
 * on does not return nothing. It returns its best guess — "you", "Thank you.",
 * a fragment of whatever was on the television. Saving that as the Client's
 * answer would put it in the Q&A bank and reuse it on every future application,
 * which is considerably worse than not having an answer at all.
 *
 * So a transcript that is too short, or is one of the known artefacts, is
 * rejected and the Client is asked to try again. Rejecting a genuine one-word
 * answer is a cost worth paying: they can still type it.
 */
const TRANSCRIPTION_ARTEFACTS = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'okay',
  'so',
  'mbc 뉴스 이덕영입니다',
]);

const MIN_TRANSCRIPT_CHARS = 4;

export function acceptTranscript(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  const normalised = text.toLowerCase().replace(/[.!?,]+$/g, '').trim();

  if (text.length < MIN_TRANSCRIPT_CHARS || TRANSCRIPTION_ARTEFACTS.has(normalised)) {
    throw new VoiceAnswerError(
      'Nothing could be made out from that recording. Try again, or type the answer.',
    );
  }

  return text;
}
