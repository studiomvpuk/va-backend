import {
  isGenuineGap,
  resolveGap,
  shouldResumeOnModeChange,
  type GapContext,
  type GapSignal,
} from './gap-resolution';

const SIGNAL: GapSignal = {
  bestEffortAnswer: 'Immediately available',
  confidence: 'low',
  assumption: 'no notice period is recorded, so a standard one was assumed',
};

const CONTEXT: GapContext = {
  mode: 'GUESS_AND_PROCEED',
  signal: SIGNAL,
  questionText: 'What is your notice period?',
  companyName: 'Sky Capital',
  roleTitle: 'Admin Assistant',
};

describe('isGenuineGap', () => {
  it('low confidence is always a gap', () => {
    expect(isGenuineGap({ ...SIGNAL, confidence: 'low', assumption: '' })).toBe(true);
  });

  it('medium confidence WITH an assumption is a gap', () => {
    expect(isGenuineGap({ ...SIGNAL, confidence: 'medium' })).toBe(true);
  });

  /**
   * The line that keeps the queue worth reading.
   */
  it('medium confidence with NO assumption is not a gap', () => {
    // The model answered from the profile and is hedging about style. Flagging
    // that would bury the Client, and a queue nobody reads is no queue at all.
    expect(isGenuineGap({ ...SIGNAL, confidence: 'medium', assumption: '' })).toBe(false);
  });

  it('medium confidence with only whitespace is not a gap', () => {
    expect(isGenuineGap({ ...SIGNAL, confidence: 'medium', assumption: '   ' })).toBe(false);
  });

  it('high confidence is never a gap', () => {
    expect(isGenuineGap({ ...SIGNAL, confidence: 'high' })).toBe(false);
    expect(isGenuineGap({ ...SIGNAL, confidence: 'high', assumption: 'something' })).toBe(
      false,
    );
  });
});

describe('GUESS_AND_PROCEED', () => {
  const action = resolveGap(CONTEXT);

  it('proceeds with the best-effort answer', () => {
    expect(action.kind).toBe('proceed');
    expect(action.kind === 'proceed' && action.answer).toBe('Immediately available');
  });

  it('keeps the assumption on the record', () => {
    expect(action.kind === 'proceed' && action.assumption).toMatch(/no notice period/);
  });

  it('notifies without urgency — the application already went out', () => {
    expect(action.notify.urgent).toBe(false);
  });

  it('tells the Client nothing is waiting on them', () => {
    expect(action.notify.body).toMatch(/nothing is waiting on you/i);
  });

  it('includes the question AND the answer used, so they can correct from the notification', () => {
    expect(action.notify.body).toContain('What is your notice period?');
    expect(action.notify.body).toContain('Immediately available');
  });

  it('says the correction will be reused', () => {
    expect(action.notify.body).toMatch(/reused from then on/i);
  });

  it('omits the assumption line when there was none', () => {
    const noAssumption = resolveGap({
      ...CONTEXT,
      signal: { ...SIGNAL, assumption: '' },
    });
    expect(noAssumption.notify.body).not.toMatch(/Assumed:/);
  });
});

describe('ASK_FIRST', () => {
  const action = resolveGap({ ...CONTEXT, mode: 'ASK_FIRST' });

  it('pauses rather than guessing', () => {
    expect(action.kind).toBe('pause');
  });

  it('never leaks the best-effort answer to the VA', () => {
    // The Client asked to be consulted; showing the guess anyway would make the
    // consultation decorative.
    expect(JSON.stringify(action)).not.toContain('Immediately available');
  });

  it('tells the VA what to do instead of leaving them stuck', () => {
    expect(action.kind === 'pause' && action.vaMessage).toMatch(/carry on with another/i);
    expect(action.kind === 'pause' && action.vaMessage).toMatch(/have been\s+notified/i);
  });

  it('notifies urgently — a person is blocked', () => {
    expect(action.notify.urgent).toBe(true);
    expect(action.notify.title).toMatch(/waiting on you/i);
  });

  it('puts the question in the notification so it can be answered from there', () => {
    expect(action.notify.body).toContain('What is your notice period?');
  });

  it('names the role, so a Client with several in flight knows which', () => {
    expect(action.notify.title).toContain('Admin Assistant at Sky Capital');
  });
});

describe('changing the mode', () => {
  it('applies to the next gap', () => {
    // The mode is an argument, read at gap time — there is nowhere to cache it.
    expect(resolveGap({ ...CONTEXT, mode: 'GUESS_AND_PROCEED' }).kind).toBe('proceed');
    expect(resolveGap({ ...CONTEXT, mode: 'ASK_FIRST' }).kind).toBe('pause');
  });

  /**
   * The PRD says not retroactively. The stronger reason is consent.
   */
  it('does NOT un-pause an application already waiting', () => {
    // The Client asked to be consulted about THIS question. Proceeding without
    // them because they later changed a general preference would be answering
    // on their behalf after they said not to.
    expect(shouldResumeOnModeChange()).toBe(false);
  });

  it('is deterministic for the same context', () => {
    const first = resolveGap(CONTEXT);
    for (let i = 0; i < 20; i++) expect(resolveGap(CONTEXT)).toEqual(first);
  });
});
