import { NoSearchProvider } from './no-search.provider';

describe('NoSearchProvider', () => {
  it('returns no results rather than failing', async () => {
    // "No findable company information" is a specified outcome, not an error,
    // so the unconfigured case has to produce it rather than throw.
    await expect(new NoSearchProvider().search()).resolves.toEqual([]);
  });

  it('warns once, not per search', async () => {
    const provider = new NoSearchProvider();
    const warn = jest
      .spyOn(provider['logger'], 'warn')
      .mockImplementation(() => undefined);

    // A single prep document issues several searches; a missing optional key
    // should not be the loudest thing in the log.
    await provider.search();
    await provider.search();
    await provider.search();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
