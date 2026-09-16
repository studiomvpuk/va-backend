import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/core/persistence/prisma.service';

/**
 * Compiles the real application.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * 918 unit tests passed while the application could not start. Every one of
 * them constructed its service directly with mocks — `new VaService(repo, ...)`
 * — which is the right way to test behaviour and is completely blind to
 * wiring. Nest's dependency graph was never assembled, so a provider that no
 * module exported failed nowhere until a container tried to boot in production:
 *
 *   Nest can't resolve dependencies of the VaService
 *   (Symbol(VA_REPOSITORY), ?, Symbol(AUDIT_LOGGER), TokenService).
 *   Please make sure that the argument Symbol(PASSWORD_HASHER) at index [1]
 *   is available in the VaModule module.
 *
 * `AuthModule` provided PASSWORD_HASHER but exported only AuthService and
 * TokenService, so VaModule — which imports AuthModule — could not see it.
 *
 * `.compile()` instantiates every provider in the graph, which is precisely the
 * step that catches this class of bug, and it is a class no amount of unit
 * testing reaches. It deliberately stops short of `.init()`: lifecycle hooks
 * would open a database connection, and a wiring test should not need one.
 *
 * If this fails, read the message — it names the missing token, the service
 * that wanted it, and the module that should have had it.
 */

// Set before AppModule is imported: the config module validates at module load.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = 'postgresql://u:p@localhost:5432/db';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.WEB_ORIGIN = 'http://localhost:3000';

describe('the application module graph', () => {
  it('resolves every provider — the app can actually start', async () => {
    // Imported here rather than at the top so the env above is already set.
    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The only stub. Everything else is the real wiring, because the real
      // wiring is the thing under test.
      .overrideProvider(PrismaService)
      .useValue({ client: {}, $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30_000);
});
