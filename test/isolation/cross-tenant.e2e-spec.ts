import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/core/persistence/prisma.service';
import { runUnscoped } from '../../src/core/tenancy/tenant.context';

/**
 * THE ISOLATION TEST.
 *
 * Two Clients with identical data shapes. Every list endpoint, called with
 * Client A's token, must return zero of Client B's rows.
 *
 * From the PRD, Phase 1: "Automated, runs in CI on every push, and is a
 * blocking test forever." As later phases add endpoints, they get added to
 * LIST_ENDPOINTS below — the test is data-driven so that covering a new route
 * is one line, and forgetting to cover one is visible in the diff.
 *
 * Requires a real Postgres (DATABASE_URL). Run with `npm run test:integration`.
 */

interface Endpoint {
  path: string;
  /** A value belonging to Client B that must never appear in A's response. */
  bTellTale: (seed: Seed) => string;
}

const LIST_ENDPOINTS: Endpoint[] = [
  // Phase 1 has no list endpoints yet beyond auth. Each phase adds its own:
  //   { path: '/v1/profile',      bTellTale: (s) => s.b.profileFieldId },
  //   { path: '/v1/sites',        bTellTale: (s) => s.b.siteId },
  //   { path: '/v1/applications', bTellTale: (s) => s.b.applicationId },
];

interface Seed {
  a: { id: string; email: string; password: string; accessToken: string };
  b: { id: string; email: string; password: string; accessToken: string };
}

describe('cross-tenant isolation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seed: Seed;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    seed = await seedTwoClients(app);
  });

  afterAll(async () => {
    await cleanup(prisma, seed);
    await app.close();
  });

  it('seeds two distinct clients', () => {
    expect(seed.a.id).not.toBe(seed.b.id);
    expect(seed.a.accessToken).toBeTruthy();
    expect(seed.b.accessToken).toBeTruthy();
  });

  if (LIST_ENDPOINTS.length > 0) {
    describe.each(LIST_ENDPOINTS)('$path', ({ path, bTellTale }) => {
      it("returns none of the other Client's rows", async () => {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${seed.a.accessToken}`)
          .expect(200);

        // Search the whole serialised body, not just a field we remembered to
        // check — a leak through an unexpected relation still fails this.
        expect(JSON.stringify(res.body)).not.toContain(bTellTale(seed));
      });

      it('is symmetric — B cannot see A either', async () => {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${seed.b.accessToken}`)
          .expect(200);
        expect(JSON.stringify(res.body)).not.toContain(seed.a.id);
      });
    });
  }

  describe('token boundaries', () => {
    it('rejects a request with no token', async () => {
      await request(app.getHttpServer()).post('/v1/auth/logout-everywhere').expect(401);
    });

    it('rejects a garbage token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/logout-everywhere')
        .set('Authorization', 'Bearer not.a.token')
        .expect(401);
    });
  });

  describe('the scoping mechanism itself', () => {
    it('throws rather than returning rows when no tenant is in context', async () => {
      // Direct database access outside a request — the failure mode this
      // mechanism exists to make impossible.
      await expect(prisma.client.application.findMany({})).rejects.toThrow(
        /tenant context/i,
      );
    });

    it('cannot reach another tenant even when its id is supplied explicitly', async () => {
      const rows = await runScopedTo(seed.a.id, () =>
        prisma.client.application.findMany({ where: { clientId: seed.b.id } }),
      );
      expect(rows).toHaveLength(0);
    });
  });
});

// --------------------------------------------------------------------------

async function seedTwoClients(app: INestApplication): Promise<Seed> {
  const make = async (tag: string) => {
    const email = `isolation-${tag}-${Date.now()}@example.test`;
    const password = 'isolation-test-password';
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ fullName: `Isolation ${tag}`, email, password })
      .expect(201);
    return {
      id: res.body.user.id as string,
      email,
      password,
      accessToken: res.body.accessToken as string,
    };
  };
  return { a: await make('a'), b: await make('b') };
}

async function runScopedTo<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  const { tenantContext } = await import('../../src/core/tenancy/tenant.context');
  return new Promise<T>((resolve, reject) => {
    tenantContext.run(
      { clientId, actorType: 'CLIENT', actorId: clientId },
      () => void fn().then(resolve, reject),
    );
  });
}

async function cleanup(prisma: PrismaService, seed: Seed): Promise<void> {
  await runUnscoped(async () => {
    await prisma.client.client.deleteMany({
      where: { id: { in: [seed.a.id, seed.b.id] } },
    });
  }, 'integration test cleanup');
}
