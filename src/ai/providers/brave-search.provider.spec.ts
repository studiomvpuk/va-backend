import { BraveSearchProvider, toResults } from './brave-search.provider';
import { ScriptedTransport } from './provider-contract';
import { TransportFailure } from './transport';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';

const ok = {
  web: {
    results: [
      {
        title: 'Sky Capital Partners',
        url: 'https://example.com/sky',
        description: 'A <strong>Manchester</strong> investment firm founded in 2011.',
        page_age: '2026-01-02',
      },
    ],
  },
};

describe('BraveSearchProvider', () => {
  it('returns results with their URLs', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: ok }]);
    const results = await new BraveSearchProvider(transport, 'k').search({
      query: 'Sky Capital Partners',
    });

    expect(results).toEqual([
      {
        title: 'Sky Capital Partners',
        url: 'https://example.com/sky',
        snippet: 'A Manchester investment firm founded in 2011.',
        publishedAt: '2026-01-02',
      },
    ]);
  });

  it('strips the engine’s markup before the text reaches a prompt', () => {
    // Leaving <strong> in invites a model to read it as structure.
    expect(
      toResults({ web: { results: [{ url: 'https://x', description: '<b>a</b> b' }] } })[0]
        .snippet,
    ).toBe('a b');
  });

  it('drops a result with no URL — a claim with no source is unusable', () => {
    expect(toResults({ web: { results: [{ title: 'No link', description: 'x' }] } })).toEqual(
      [],
    );
  });

  it.each([
    ['an empty result set', { web: { results: [] } }],
    ['no web section at all', {}],
    ['a body that is not an object', 'nope'],
  ])('returns [] for %s rather than throwing', (_label, body) => {
    // A company with no web presence is a normal outcome, not an error.
    expect(toResults(body)).toEqual([]);
  });

  it('authenticates with the subscription header and asks for no AI summary', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: ok }]);
    await new BraveSearchProvider(transport, 'secret').search({ query: 'x', limit: 3 });

    expect(transport.sent[0].headers['x-subscription-token']).toBe('secret');
    expect(transport.sent[0].url).toContain('count=3');
    expect(transport.sent[0].url).toContain('summary=0');
  });

  it('caps the count rather than passing a caller’s number through', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: ok }]);
    await new BraveSearchProvider(transport, 'k').search({ query: 'x', limit: 500 });
    expect(transport.sent[0].url).toContain('count=20');
  });

  it.each([
    [401, ProviderAuthError],
    [403, ProviderAuthError],
    [429, ProviderRateLimitError],
    [503, ProviderUnavailableError],
  ])('maps HTTP %s to the shared error vocabulary', async (status, expected) => {
    const transport = new ScriptedTransport([{ status, body: {} }]);
    await expect(
      new BraveSearchProvider(transport, 'k').search({ query: 'x' }),
    ).rejects.toBeInstanceOf(expected);
  });

  it('maps an unreachable host to unavailable', async () => {
    const transport = new ScriptedTransport([], [], new TransportFailure('ECONNRESET'));
    await expect(
      new BraveSearchProvider(transport, 'k').search({ query: 'x' }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
