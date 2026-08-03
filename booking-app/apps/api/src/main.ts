import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { correlationMiddleware } from './common/correlation/correlation.middleware.js';
import { InFlightRequests } from './common/shutdown/inflight.js';
import { assertAppRole, loadConfig } from './config/env.schema.js';
import { loadEnvFile } from './config/load-dotenv.js';
import { WEBHOOK_BODY_LIMIT, webhookBodyParser } from './webhooks/raw-body.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const envFile = loadEnvFile();

  // Validate configuration and the process role before building the container,
  // so a misconfigured role cannot open a database connection on its way to
  // exiting. loadConfig is memoised, so the Nest provider reuses this result.
  const config = loadConfig();
  assertAppRole(config, 'api');

  // Imported here rather than at the top of the file, and it has to be: AppModule
  // decides at decorator-evaluation time whether the test-support router is part of
  // the container, and a static import is hoisted above `loadEnvFile()` — so it
  // would read an environment the .env file had not been applied to yet.
  const { AppModule } = await import('./app.module.js');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Keeps the unparsed bytes on the request while still parsing JSON normally. The
    // Stripe webhook needs them: a signature covers the exact bytes sent.
    rawBody: true,
  });

  // Signature verification consumes the exact bytes. Mount this route-specific parser
  // before the global JSON/form parsers so oversized webhook requests are rejected while
  // their bytes are buffered and valid requests remain available as a Buffer.
  app.use('/api/webhooks', webhookBodyParser);

  // `rawBody: true` alone leaves the parser at Express's 100 KB default, so a large webhook
  // event would be rejected before any handler saw it. Through `useBodyParser` rather than
  // `app.use(bodyParser…)`: mounting a parser by hand replaces the one Nest instrumented and
  // silently leaves `request.rawBody` undefined, which is the failure every signature check
  // here depends on not happening.
  app.useBodyParser('json', { limit: WEBHOOK_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: WEBHOOK_BODY_LIMIT, extended: true });

  // Route Nest's own logs through pino, so everything is one structured stream.
  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  // Before everything, including the guards: a request rejected by one is still a
  // request being served, and ending it under the client is what the drain exists
  // to avoid.
  app.use(app.get(InFlightRequests).middleware);

  // Then, and before pino's request logger: everything downstream — including that
  // logger — reads the correlation id from the scope this opens.
  app.use(correlationMiddleware);

  app.setGlobalPrefix('api');
  app.use(helmet());
  // Rate limits and audit rows must record the real client IP, not the proxy's.
  app.set('trust proxy', 1);
  app.enableShutdownHooks();

  await app.listen(config.PORT);

  logger.log(`Environment file: ${envFile ?? '(ambient environment only)'}`);
  logger.log(`Listening on http://localhost:${String(config.PORT)}/api (${config.NODE_ENV})`);
}

await bootstrap();
