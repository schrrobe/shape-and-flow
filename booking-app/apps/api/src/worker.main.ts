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

  await scheduler.install();
  registrar.start();

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

  // A worker that keeps running after an unhandled rejection is worse than one that exits:
  // it holds its queue's locks while being unable to finish anything. Exiting non-zero lets
  // the supervisor replace it.
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}

await bootstrap();
