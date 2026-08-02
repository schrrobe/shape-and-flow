import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stackEnv } from '../playwright.config.js';

import type { ChildProcess } from 'node:child_process';

/**
 * Starts the queue worker for the run, and stops it afterwards.
 *
 * Not a `webServer` entry: Playwright polls those on a port, and a worker has none —
 * it is a queue consumer, and giving it an HTTP listener purely to be startable by a
 * test runner would make the test environment differ from production in exactly the
 * way this suite exists to rule out.
 *
 * So it is started here and waited on by its own log line. Waiting matters: the first
 * test enqueues a job within a second of the run beginning, and a worker that is still
 * constructing its Prisma client at that point makes the failure look like a bug in
 * the expiry saga.
 */

const API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));

/** Printed by worker.main.ts once the registrar is consuming. */
const READY_LINE = 'Worker running';

const STARTUP_TIMEOUT_MS = 60_000;

export default async function globalSetup(): Promise<() => Promise<void>> {
  const worker = spawn('node', ['dist/worker.main.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      ...stackEnv,
      APP_ROLE: 'worker',
      // Louder than the rest of the stack, deliberately. `Worker running` is an info
      // line and it is what this function waits for, and when a journey fails the
      // question is almost always which job ran and what it decided.
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForReady(worker);

  return async () => {
    await stop(worker);
  };
}

function waitForReady(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';

    const timer = setTimeout(() => {
      finish(new Error(`The worker did not start within 60s. Output so far:\n${output}`));
    }, STARTUP_TIMEOUT_MS);

    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output += text;
      // Forwarded, because a worker that fails to start says why on its own stderr and
      // a silent global setup would report only that the timeout elapsed.
      process.stdout.write(`[worker] ${text}`);
      if (output.includes(READY_LINE)) finish();
    };

    const finish = (error?: Error): void => {
      clearTimeout(timer);
      worker.stdout?.off('data', onChunk);
      worker.stderr?.off('data', onChunk);
      worker.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };

    const onExit = (code: number | null): void => {
      finish(new Error(`The worker exited with code ${String(code)} before starting:\n${output}`));
    };

    worker.stdout?.on('data', onChunk);
    worker.stderr?.on('data', onChunk);
    worker.on('exit', onExit);
  });
}

/**
 * SIGTERM, then wait.
 *
 * The worker drains in-flight jobs before exiting, which is the behaviour task 11.2
 * added; killing it outright would leave a stalled job in Redis for the next run to
 * inherit and misattribute.
 */
async function stop(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      worker.kill('SIGKILL');
      resolve();
    }, 10_000);

    worker.once('exit', () => {
      clearTimeout(force);
      resolve();
    });

    worker.kill('SIGTERM');
  });
}
