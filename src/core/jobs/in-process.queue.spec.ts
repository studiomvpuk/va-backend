import { InProcessQueue } from './in-process.queue';

describe('InProcessQueue', () => {
  it('returns before the handler has run', async () => {
    const queue = new InProcessQueue();
    const order: string[] = [];

    queue.register('prep-document.generate', () => {
      order.push('handled');
      return Promise.resolve();
    });

    await queue.enqueue('prep-document.generate', {
      clientId: 'c1',
      applicationId: 'a1',
    });
    order.push('returned');

    // The whole point: the caller's response is already on its way out.
    expect(order).toEqual(['returned']);

    await queue.drain();
    expect(order).toEqual(['returned', 'handled']);
  });

  it('passes the payload through unchanged', async () => {
    const queue = new InProcessQueue();
    const seen: unknown[] = [];
    queue.register('prep-document.generate', (payload) => {
      seen.push(payload);
      return Promise.resolve();
    });

    await queue.enqueue('prep-document.generate', {
      clientId: 'c1',
      applicationId: 'a1',
    });
    await queue.drain();

    expect(seen).toEqual([{ clientId: 'c1', applicationId: 'a1' }]);
  });

  it('swallows a failing handler rather than crashing the process', async () => {
    const queue = new InProcessQueue();
    queue.register('prep-document.generate', () => Promise.reject(new Error('boom')));

    await queue.enqueue('prep-document.generate', { clientId: 'c1', applicationId: 'a1' });
    // An unhandled rejection in a setImmediate takes the whole API down.
    await expect(queue.drain()).resolves.toBeUndefined();
  });

  it('does not reject when nothing is registered', async () => {
    // It logs an error instead — a job nobody runs looks exactly like a job
    // still running to whatever screen is waiting on it.
    const queue = new InProcessQueue();
    await expect(
      queue.enqueue('prep-document.generate', { clientId: 'c1', applicationId: 'a1' }),
    ).resolves.toBeUndefined();
  });

  it('drains work enqueued by other work', async () => {
    const queue = new InProcessQueue();
    let nested = false;
    queue.register('prep-document.generate', async (payload) => {
      if (payload.applicationId === 'first') {
        await queue.enqueue('prep-document.generate', {
          clientId: 'c1',
          applicationId: 'second',
        });
      } else {
        nested = true;
      }
    });

    await queue.enqueue('prep-document.generate', { clientId: 'c1', applicationId: 'first' });
    await queue.drain();

    expect(nested).toBe(true);
  });
});
