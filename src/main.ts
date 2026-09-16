import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './core/config/app-config.service';
import {
  PRODUCTION_LOG_LEVELS,
  RedactingLogger,
} from './core/observability/redacting.logger';
import { registerSecret } from './core/observability/secret-registry';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);

  /*
   * Registration happens before the logger is installed, and the logger is
   * installed before anything is flushed.
   *
   * `bufferLogs: true` is what makes that possible: everything Nest logs during
   * module initialisation is held, and released through the redactor once it is
   * set. Without the buffer, the boot messages — the ones most likely to
   * mention a connection string — would go out through the default logger.
   */
  registerSecrets(config);

  const redacting = new RedactingLogger();
  redacting.setLogLevels(
    config.isProduction
      ? PRODUCTION_LOG_LEVELS
      : ['log', 'warn', 'error', 'fatal', 'debug', 'verbose'],
  );
  app.useLogger(redacting);

  const logger = new Logger('bootstrap');

  app.setGlobalPrefix('v1');
  app.use(helmet());
  app.use(cookieParser());

  // CORS is an exact allowlist. The env schema already rejects "*".
  app.enableCors({
    origin: config.get('WEB_ORIGIN'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // strip properties with no DTO decorator
      forbidNonWhitelisted: true, // and reject the request that sent them
      transform: true,
    }),
  );

  if (!config.isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Understudy API')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  app.enableShutdownHooks();

  const port = config.get('PORT');
  /*
   * Bind every interface, not just loopback.
   *
   * A container platform reaches the process from outside the container. A
   * server listening only on 127.0.0.1 accepts nothing from the host network,
   * and the symptom is not a crash — it is a healthy-looking process that every
   * request times out against, which is a much worse afternoon than a boot
   * failure. Explicit because the default has changed between Node versions.
   */
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on 0.0.0.0:${port} (${config.get('NODE_ENV')})`);
}

/**
 * Every literal secret this process holds, handed to the redactor at boot.
 *
 * An encryption key is 32 random bytes in base64 and looks like any other
 * base64 blob; no pattern finds it. Exact-value replacement does — but only for
 * values it has been given, which is why this list is enumerated here rather
 * than inferred. A secret added to the env schema and not added here is a
 * secret the redactor cannot see, so the two lists are checked against each
 * other by a test.
 */
function registerSecrets(config: AppConfigService): void {
  registerSecret(config.get('ENCRYPTION_KEY'));
  // The retiring key during a rotation. Just as sensitive as the current one —
  // it still opens every record that has not moved yet.
  registerSecret(config.get('ENCRYPTION_KEY_PREVIOUS'));
  registerSecret(config.get('JWT_SECRET'));
  // Both signing secrets. The refresh secret was missing from the first version
  // of this function and the architecture test below is what found it — which
  // is the whole argument for the test existing rather than a code review.
  registerSecret(config.get('JWT_REFRESH_SECRET'));
  registerSecret(config.get('DATABASE_URL'));
  // The migration connection. Same credentials, different variable, and just as
  // likely to appear in a Prisma error message.
  registerSecret(config.get('DIRECT_URL'));
  registerSecret(config.get('ANTHROPIC_API_KEY'));
  registerSecret(config.get('OPENAI_API_KEY'));
  registerSecret(config.get('RESEND_API_KEY'));
  registerSecret(config.get('BRAVE_SEARCH_API_KEY'));
  registerSecret(config.get('WHATSAPP_ACCESS_TOKEN'));
  registerSecret(config.get('SUPABASE_SERVICE_KEY'));
  registerSecret(config.get('REDIS_URL'));
}

bootstrap().catch((error: unknown) => {
  // Env validation failures land here. Exit non-zero with the full message so
  // the reason is visible in a deploy log, not swallowed.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
