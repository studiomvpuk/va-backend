import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { PRODUCTION_LOG_LEVELS, RedactingLogger } from '../../observability/redacting.logger';
import { KeyRotationService, type RotationReport } from './key-rotation.service';

/**
 * `npm run rotate-keys [-- --dry-run]`
 *
 * A command rather than a route or a scheduled job. Re-encrypting every stored
 * secret across every tenant is something an operator does while watching it,
 * with the runbook open — not something an HTTP request or a cron entry can
 * start unattended.
 *
 * The runbook is docs/RUNBOOK-key-rotation.md. This command is step 3 of it.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The report names no secret, but the rotation reads every one of them and
    // a failure message could carry a fragment. Same redactor as the API.
    logger: (() => {
      const logger = new RedactingLogger('rotate-keys');
      logger.setLogLevels(PRODUCTION_LOG_LEVELS);
      return logger;
    })(),
  });

  try {
    const rotation = app.get(KeyRotationService);
    const report = dryRun ? await rotation.status() : await rotation.rotate();
    print(report, dryRun);

    // Non-zero on any failure, so this is usable in a deploy pipeline without
    // someone having to read the output to find out whether it worked.
    process.exitCode = report.failures.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

function print(report: RotationReport, dryRun: boolean): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(dryRun ? '── Key rotation (dry run) ──' : '── Key rotation ──');
  lines.push(`  writing new records at version : ${report.toVersion}`);
  lines.push(`  versions this process can read  : ${report.readableVersions.join(', ')}`);
  lines.push('');

  for (const table of Object.keys(report.rotated)) {
    const verb = dryRun ? 'would move' : 'moved';
    lines.push(
      `  ${table.padEnd(16)} ${verb} ${String(report.rotated[table]).padStart(6)}` +
        `   still on an old key: ${report.remaining[table]}`,
    );
  }

  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`  ${report.failures.length} row(s) could not be re-encrypted:`);
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`    ${failure.table} ${failure.id}: ${failure.reason}`);
    }
    if (report.failures.length > 20) {
      lines.push(`    …and ${report.failures.length - 20} more`);
    }
  }

  lines.push('');
  if (dryRun) {
    lines.push('  Dry run — nothing was written.');
  } else if (report.previousKeyRetirable) {
    // The only signal that matters at the end of a rotation, and the one thing
    // an operator must not guess at.
    lines.push('  ✓ No records remain on a previous key.');
    lines.push('    ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_PREVIOUS_VERSION can now be');
    lines.push('    removed from the environment. Redeploy, then run --dry-run once more.');
  } else {
    lines.push('  ✗ Records remain on a previous key. LEAVE ENCRYPTION_KEY_PREVIOUS IN PLACE');
    lines.push('    and run this again. Removing it now makes those records unreadable.');
  }
  lines.push('');

  // process.stdout, not the logger: this is a report a person reads, not an
  // event stream. It contains no secret — the redactor covers the log path.
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
