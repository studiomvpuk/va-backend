# Dependency overrides

`package.json` pins two transitive dependencies above what their parents ask
for. Each one is here because `npm audit` reported a high-severity advisory and
the parent had not yet released a version that carries the fix.

An override is a claim that a newer version is compatible, and that claim needs
re-checking. Remove each entry as soon as the parent catches up — `npm ls <pkg>`
will then show the parent's own resolution.

| Package | Pinned | Why |
|---|---|---|
| `multer` | `^2.4.0` | Four DoS advisories in `multer < 2.3.0`, reached via `@nestjs/platform-express@11`. The clean upstream fix is `@nestjs/platform-express@12`, which is a major bump of the whole Nest stack — a large, risky change to make for a dependency this API never actually exercises: every route takes JSON, and screenshots arrive base64-encoded in a body rather than as multipart. The override moves within multer's own major, so platform-express's `^2.0.0` peer range is still satisfied. **Remove when Nest 12 is adopted.** |
| `deepmerge-ts` | `^8.0.2` | Stack exhaustion on recursive object graphs in `< 8.0.0`, reached via `prisma → @prisma/config`. Build-time only — it merges Prisma's own config, never user input — but it is a one-line pin rather than an argument. **Remove when Prisma's own dependency moves to 8.** |

## Checking

```bash
npm audit --audit-level=high    # must report zero
npm ls multer deepmerge-ts      # confirm the override actually took effect
```

Both run in CI. An override that stops taking effect — because a parent moved
the dependency, or renamed it — fails the audit rather than passing quietly.
