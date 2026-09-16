import { GapDetectionError, parseSignal } from './gap-detector';

describe('parseSignal', () => {
  it('reads a well-formed signal', () => {
    expect(
      parseSignal('{"answer":"One month","confidence":"medium","assumption":"standard UK notice"}'),
    ).toEqual({
      bestEffortAnswer: 'One month',
      confidence: 'medium',
      assumption: 'standard UK notice',
    });
  });

  it('digs the JSON out of surrounding prose and fences', () => {
    const raw = 'Here you go:\n```json\n{"answer":"One month","confidence":"high"}\n```\nHope that helps!';
    expect(parseSignal(raw).bestEffortAnswer).toBe('One month');
  });

  it('defaults a missing assumption to empty rather than inventing one', () => {
    expect(parseSignal('{"answer":"One month","confidence":"high"}').assumption).toBe('');
  });

  it('treats an unrecognised confidence as low', () => {
    // Low makes it a gap, which puts it in front of the Client. One extra
    // question beats a silent guess.
    expect(parseSignal('{"answer":"x","confidence":"quite sure"}').confidence).toBe('low');
    expect(parseSignal('{"answer":"x"}').confidence).toBe('low');
  });

  it.each([
    ['prose with no JSON at all', 'I am not sure I can answer that.'],
    ['malformed JSON', '{"answer": "One month", '],
    ['no answer field', '{"confidence":"high","assumption":"none"}'],
    ['an empty answer', '{"answer":"   ","confidence":"high"}'],
  ])('throws on %s rather than reporting a gap', (_label, raw) => {
    // A gap with an empty best-effort answer would, in GUESS_AND_PROCEED mode,
    // put an empty string into a real application and tell the Client it was
    // answered for them.
    expect(() => parseSignal(raw)).toThrow(GapDetectionError);
  });
});
