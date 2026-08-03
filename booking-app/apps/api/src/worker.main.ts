import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import { assertAppRole, loadConfig } from './config/env.schema.js';
import { loadEnvFile } from './config/load-dotenv.js';
import { SchedulerService } from './messaging/queues/scheduler.service.js';
import { WorkerRegistrarService } from './messaging/queues/worker-registrar.service.js';
import { WorkerModule } from './worker.module.js';

/**
 * The worker entrypoint.
 *
 * `createApplicationContext`, not `create`: no HTTP server, no port, nothing listening. A
 * worker that accidentally served traffic would be reachable through a load balancer that
 * nobody meant to point at it.
 */
async function bootstrap(): Promise<void> {
  const envFile = loadEnvFile();

  // These have to exist before Nest builds the container: module initialisation can reject
  // while opening PostgreSQL or Redis, before the configured application logger exists.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`unhandled rejection: ${detail}\n`);
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    process.stderr.write(`uncaught exception: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });

  // The role is checked before the container is built, so a process started with the wrong
  // role exits without opening a database connection or claiming a job. Two processes from
  // one image differ only by this variable, which makes it the thing worth asserting.
  const config = loadConfig();
  assertAppRole(config, 'worker');

  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);
  app.flushLogs();

  const registrar = app.get(WorkerRegistrarService);
  const scheduler = app.get(SchedulerService);

  try {
    await scheduler.install();
    registrar.start();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.error(`worker start-up failed: ${detail}`);

    // `start` can fail after opening only some workers. Stop whatever exists and close the
    // Nest container even when one cleanup operation reports an already-broken connection.
    await Promise.allSettled([registrar.stop(), app.close()]);
    process.exit(1);
  }

  logger.log(`Environment file: ${envFile ?? '(ambient environment only)'}`);
  logger.log(
    `Worker running (${config.NODE_ENV}), handling ${String(registrar.handledJobNames().length)} job types`,
  );
  for (const entry of await scheduler.installed()) {
    logger.log(
      `repeatable ${entry.name}: ${entry.pattern ?? `every ${String((entry.every ?? 0) / 1000)}s`}`,
    );
  }

  let stopping = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during a drain is common — an impatient operator, or an orchestrator
    // that sends SIGTERM then SIGINT — and must not start a second shutdown.
    if (stopping) return;
    stopping = true;

    logger.log(`${signal} received; draining`);

    // Workers first, then the container. Closing Nest first would tear down the Prisma
    // client under a job that is still running, turning a clean stop into a failed job.
    await registrar.stop();
    await app.close();

    logger.log('worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await bootstrap();
