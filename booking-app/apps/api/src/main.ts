import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { correlationMiddleware } from './common/correlation/correlation.middleware.js';
import { InFlightRequests } from './common/shutdown/inflight.js';
import { assertAppRole, loadConfig } from './config/env.schema.js';
import { loadEnvFile } from './config/load-dotenv.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const envFile = loadEnvFile();

  // Validate configuration and the process role before building the container,
  // so a misconfigured role cannot open a database connection on its way to
  // exiting. loadConfig is memoised, so the Nest provider reuses this result.
  const config = loadConfig();
  assertAppRole(config, 'api');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Keeps the unparsed bytes on the request while still parsing JSON normally. The
    // Stripe webhook needs them: a signature covers the exact bytes sent.
    rawBody: true,
  });

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
