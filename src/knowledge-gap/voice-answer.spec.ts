import {
  acceptTranscript,
  assertAcceptableAudio,
  MAX_AUDIO_BYTES,
  VoiceAnswerError,
} from './voice-answer';

describe('assertAcceptableAudio', () => {
  it('accepts what a phone actually records', () => {
    for (const mediaType of ['audio/mp4', 'audio/webm', 'audio/ogg']) {
      expect(() => assertAcceptableAudio({ bytes: 120_000, mediaType })).not.toThrow();
    }
  });

  it('rejects an empty recording', () => {
    expect(() => assertAcceptableAudio({ bytes: 0, mediaType: 'audio/mp4' })).toThrow(
      VoiceAnswerError,
    );
  });

  it('rejects a recording too long to be an answer', () => {
    expect(() =>
      assertAcceptableAudio({ bytes: MAX_AUDIO_BYTES + 1, mediaType: 'audio/mp4' }),
    ).toThrow(/too long/);
  });

  it('rejects a format nothing here can transcribe', () => {
    expect(() =>
      assertAcceptableAudio({ bytes: 1_000, mediaType: 'application/zip' }),
    ).toThrow(/Unsupported audio format/);
  });
});

describe('acceptTranscript', () => {
  it('accepts a real answer and tidies the whitespace', () => {
    expect(acceptTranscript('  Three months,\n  not one.  ')).toBe('Three months, not one.');
  });

  it.each([
    ['silence transcribed as "you"', 'you'],
    ['the classic Whisper artefact', 'Thank you.'],
    ['a stray sign-off', 'Thanks for watching'],
    ['an empty string', '   '],
    ['a single character', 'a'],
  ])('rejects %s', (_label, raw) => {
    // A transcriber given silence does not return nothing — it guesses. Saving
    // that guess would put it in the Q&A bank and reuse it forever.
    expect(() => acceptTranscript(raw)).toThrow(VoiceAnswerError);
  });

  it('is case- and punctuation-insensitive about artefacts', () => {
    expect(() => acceptTranscript('THANK YOU!')).toThrow(VoiceAnswerError);
  });

  it('accepts a short but genuine answer', () => {
    // "Yes." is three characters and would be rejected; "No, I do not." is a
    // real answer and must survive.
    expect(acceptTranscript('No, I do not.')).toBe('No, I do not.');
  });

  it('tells the Client what to do instead of failing silently', () => {
    expect(() => acceptTranscript('you')).toThrow(/type the answer/);
  });
});
