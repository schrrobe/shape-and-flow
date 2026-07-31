import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
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

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

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
