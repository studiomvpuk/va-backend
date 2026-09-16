-- PRD Phase 7 acceptance:
--   "Tracker paginates to 500 applications with no perceptible degradation;
--    queries hit the [clientId, status] and [clientId, createdAt] indexes,
--    proven by EXPLAIN."
--
-- This is the proof. It builds the two indexes the schema declares, fills the
-- table with two Clients' worth of applications, and prints the plan for every
-- query the dashboard and tracker actually issue.
--
-- Run it against any empty database:
--   psql "$DATABASE_URL" -f api/test/performance/tracker-indexes.sql
--
-- What to look for in the output: "Index Scan" or "Index Only Scan" naming one
-- of the two indexes. A "Seq Scan" on this table means an index is missing or
-- a query stopped being scoped — both are regressions, and both are invisible
-- until a Client has enough history to feel them.
--
-- Read `Buffers: shared hit` as the real number. Execution times on a warm
-- 8,000-row table are all sub-millisecond and tell you nothing; the page count
-- is what grows with the table.

BEGIN;

CREATE TABLE IF NOT EXISTS app_perf (
  id              text PRIMARY KEY,
  "clientId"      text NOT NULL,
  "companyName"   text NOT NULL,
  "roleTitle"     text NOT NULL,
  "fitScore"      numeric(3,1),
  status          text NOT NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_perf_client_status  ON app_perf ("clientId", status);
CREATE INDEX IF NOT EXISTS app_perf_client_created ON app_perf ("clientId", "createdAt");

-- Population shape matters more than population size here, and getting it wrong
-- is how this file first "proved" the opposite of what it was written for.
--
-- A first attempt used two Clients with 500 applications each. Every plan below
-- came back as a Seq Scan — correctly, because when a predicate matches half
-- the table an index is the slower way to read it. The planner was right and
-- the fixture was lying: no real deployment has two Clients.
--
-- So: 200 Clients, one of them heavy. `client-1` carries the 500 applications
-- the acceptance criterion names; the other 199 carry 40 each, which makes
-- `clientId` about 6% selective and gives the planner the same choice it faces
-- in production.
INSERT INTO app_perf (id, "clientId", "companyName", "roleTitle", "fitScore", status, "createdAt")
SELECT
  'app-1-' || i, 'client-1', 'Company ' || i, 'Role ' || i,
  (3 + (i % 70) / 10.0)::numeric(3,1),
  (ARRAY['SCORED','SKIPPED','IN_PROGRESS','BLOCKED','APPLIED','INTERVIEW','REJECTED','OFFER'])[1 + (i % 8)],
  now() - (i || ' hours')::interval
FROM generate_series(1, 500) i;

INSERT INTO app_perf (id, "clientId", "companyName", "roleTitle", "fitScore", status, "createdAt")
SELECT
  'app-' || c || '-' || i, 'client-' || c, 'Company ' || i, 'Role ' || i,
  (3 + (i % 70) / 10.0)::numeric(3,1),
  (ARRAY['SCORED','SKIPPED','IN_PROGRESS','BLOCKED','APPLIED','INTERVIEW','REJECTED','OFFER'])[1 + (i % 8)],
  now() - (i || ' hours')::interval
FROM generate_series(2, 200) c, generate_series(1, 40) i;

ANALYZE app_perf;

\echo ''
\echo '== 1. Tracker page: scoped, newest first, 50 rows =='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "companyName", "roleTitle", "fitScore", status, "createdAt"
FROM app_perf
WHERE "clientId" = 'client-1'
ORDER BY "createdAt" DESC
LIMIT 50;

\echo ''
\echo '== 2. Tracker filtered by status =='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, "companyName", "roleTitle", "fitScore", status, "createdAt"
FROM app_perf
WHERE "clientId" = 'client-1' AND status = 'BLOCKED'
ORDER BY "createdAt" DESC
LIMIT 50;

\echo ''
\echo '== 3. Dashboard stats: counts per status =='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT status, count(*) FROM app_perf WHERE "clientId" = 'client-1' GROUP BY status;

\echo ''
\echo '== 4. Dashboard stats: average fit over scored rows =='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT avg("fitScore") FROM app_perf
WHERE "clientId" = 'client-1' AND "fitScore" IS NOT NULL;

\echo ''
\echo '== 5. Deep page (offset 450) — the worst case the tracker can reach =='
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM app_perf
WHERE "clientId" = 'client-1'
ORDER BY "createdAt" DESC
LIMIT 50 OFFSET 450;

ROLLBACK;

-- ── Result, 2026-09-16, PostgreSQL 16 ───────────────────────────────────────
--
--   1. Index Scan Backward, app_perf_client_created   5 buffers   0.04 ms
--   2. Bitmap Index Scan,   app_perf_client_status    8 buffers   0.08 ms
--   3. Bitmap Index Scan,   app_perf_client_status    8 buffers   0.19 ms
--   4. Bitmap Index Scan,   app_perf_client_status    8 buffers   0.15 ms
--   5. Bitmap Index Scan,   app_perf_client_status    8 buffers   0.19 ms
--
-- Every query uses an index. Query 1 — the one a Client actually waits on —
-- touches five pages regardless of how much history they have, because the
-- ordered index gives the planner the top 50 without reading the rest.
--
-- Query 5 is the exception worth understanding rather than fixing. At OFFSET
-- 450 of 500 the planner stops walking the ordered index and reads the whole
-- Client's set instead, because it has to visit those rows anyway. That is the
-- correct choice at this size and it costs 8 pages. It would stop being correct
-- somewhere in the tens of thousands of applications for one Client, and the
-- answer then is keyset pagination ("createdAt < :last") rather than another
-- index — OFFSET is the thing that does not scale, not the index.
