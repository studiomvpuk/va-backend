import { UnprocessableEntityException } from '@nestjs/common';
import { CvImportService } from './cv-import.service';
import { tenantContext } from '../core/tenancy/tenant.context';
import { ProviderRateLimitError } from '../ai/providers/errors';
import type { ProviderFactory } from '../ai/provider-factory';
import type { RateLimitService } from '../ratelimit/rate-limit.service';
import type { ITextGenerator } from '../ai/providers/ai-provider.interface';

const CV = `
Tolulope Olonibua — Full-stack developer, Manchester.
Four years commercial experience. Built 12 client products at StudioMVP.
Previously at MTN Group. BSc Mathematics.
`.trim();

function generatorReturning(text: string): ITextGenerator {
  return {
    name: 'fake',
    generate: () =>
      Promise.resolve({
        text,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        stopReason: 'end' as const,
      }),
    async *stream() {},
  };
}

const limits = { consumeClientAiCall: jest.fn() } as unknown as RateLimitService;

function serviceWith(generator: ITextGenerator): CvImportService {
  const providers = {
    textGenerator: () => Promise.resolve(generator),
  } as unknown as ProviderFactory;
  return new CvImportService(providers, limits);
}

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    tenantContext.run({ clientId: 'c1', actorType: 'CLIENT', actorId: 'c1' }, () =>
      void fn().then(resolve, reject),
    );
  });

describe('CvImportService', () => {
  const good = JSON.stringify({
    narrative: 'Full-stack developer with four years of commercial experience.',
    fields: [
      {
        key: 'current_role',
        label: 'Current role',
        value: 'Full-stack developer',
        suggestedVisibility: 'GENERAL',
      },
      {
        key: 'home_address',
        label: 'Home address',
        value: '42 Rutherford Street, Manchester',
        suggestedVisibility: 'SENSITIVE',
      },
    ],
  });

  it('returns suggestions the Client can confirm', async () => {
    const result = await inTenant(() => serviceWith(generatorReturning(good)).suggestFrom(CV));
    expect(result.fields).toHaveLength(2);
    expect(result.narrative).toMatch(/Full-stack developer/);
  });

  it('records which prompt version produced them', async () => {
    const result = await inTenant(() => serviceWith(generatorReturning(good)).suggestFrom(CV));
    expect(result.promptVersion).toBe('cv.extract_fields@1.0.0');
  });

  it('carries the model’s sensitivity suggestion through', async () => {
    const result = await inTenant(() => serviceWith(generatorReturning(good)).suggestFrom(CV));
    expect(result.fields.find((f) => f.key === 'home_address')?.suggestedVisibility).toBe(
      'SENSITIVE',
    );
  });

  /**
   * The prompt tells the model not to propose these. This is what happens when
   * it does anyway.
   */
  it('DROPS a proposed government ID rather than offering it', async () => {
    const withId = JSON.stringify({
      narrative: 'Developer.',
      fields: [
        { key: 'ni', label: 'NI number', value: 'AB123456C', suggestedVisibility: 'SENSITIVE' },
        { key: 'role', label: 'Role', value: 'Developer', suggestedVisibility: 'GENERAL' },
      ],
    });
    const result = await inTenant(() =>
      serviceWith(generatorReturning(withId)).suggestFrom(CV),
    );

    expect(result.fields.map((f) => f.key)).toEqual(['role']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/National Insurance/);
  });

  it('survives a model that wraps its JSON in prose and fences', async () => {
    const messy = 'Here you go:\n```json\n' + good + '\n```\nLet me know!';
    const result = await inTenant(() =>
      serviceWith(generatorReturning(messy)).suggestFrom(CV),
    );
    expect(result.fields).toHaveLength(2);
  });

  it('normalises keys the model made up', async () => {
    const odd = JSON.stringify({
      narrative: 'x',
      fields: [{ key: 'Notice Period!!', label: 'Notice', value: '1 month' }],
    });
    const result = await inTenant(() => serviceWith(generatorReturning(odd)).suggestFrom(CV));
    expect(result.fields[0].key).toBe('notice_period');
  });

  it('skips malformed field entries instead of failing the whole import', async () => {
    const partial = JSON.stringify({
      narrative: 'x',
      fields: [{ label: 'no key' }, { key: 'ok', label: 'OK', value: 'value' }],
    });
    const result = await inTenant(() =>
      serviceWith(generatorReturning(partial)).suggestFrom(CV),
    );
    expect(result.fields.map((f) => f.key)).toEqual(['ok']);
  });

  it('rejects unparseable output with something the Client can act on', async () => {
    await expect(
      inTenant(() => serviceWith(generatorReturning('I could not read that.')).suggestFrom(CV)),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects text too short to be a CV', async () => {
    await expect(
      inTenant(() => serviceWith(generatorReturning(good)).suggestFrom('hi')),
    ).rejects.toThrow(/too short/i);
  });

  it('turns a provider error into a message, not a stack trace', async () => {
    const failing: ITextGenerator = {
      name: 'fake',
      generate: () => Promise.reject(new ProviderRateLimitError('anthropic', 30)),
        async *stream() {},
    };
    const message = await inTenant(() => serviceWith(failing).suggestFrom(CV)).catch(
      (e: Error) => e.message,
    );
    expect(message).toMatch(/Could not read the CV/);
    expect(message).toMatch(/Try again shortly/);
  });

  it('charges the Client’s daily AI allowance', async () => {
    await inTenant(() => serviceWith(generatorReturning(good)).suggestFrom(CV));
    expect(limits.consumeClientAiCall).toHaveBeenCalledWith('c1');
  });
});
