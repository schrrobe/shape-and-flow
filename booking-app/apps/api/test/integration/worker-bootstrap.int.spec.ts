import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { correlationId, hasCorrelation } from '../../src/common/correlation/correlation.store.js';
import { EnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import { JOB, QUEUE, QUEUES } from '../../src/messaging/queues/job-contracts.js';
import { SCHEDULE, SchedulerService } from '../../src/messaging/queues/scheduler.service.js';
import { WorkerRegistrarService } from '../../src/messaging/queues/worker-registrar.service.js';
import { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import { WorkerModule } from '../../src/worker.module.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';
import { queues, resetQueues } from '../redis.harness.js';

import type { INestApplicationContext } from '@nestjs/common';

const API_DIR = new URL('../..', import.meta.url).pathname;

let context: INestApplicationContext;
let registrar: WorkerRegistrarService;
let scheduler: SchedulerService;

/**
 * One container for the whole file.
 *
 * Building it is the expensive part and none of these tests mutate it — they read the routing
 * table and the installed schedule. The organization has to exist first, because
 * `OrganizationContextService` loads it at bootstrap and refuses to start without one.
 */
beforeAll(async () => {
  await resetDatabase();
  await seedOrganization(prisma);
  await resetQueues();

  context = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  registrar = context.get(WorkerRegistrarService);
  scheduler = context.get(SchedulerService);
});

afterAll(async () => {
  await registrar.stop();
  await context.close();
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
});

describe('the routing table', () => {
  it('registers a handler for every declared job name', () => {
    const handled = registrar.handledJobNames();

    // The table is a mapped type over JobName, so this cannot fail at runtime without
    // failing to compile first. It is here because that guarantee is the point of the
    // design and a future refactor to a plain Record would silently lose it.
    for (const name of Object.values(JOB)) expect(handled, name).toContain(name);
    expect(handled).toHaveLength(Object.values(JOB).length);
  });

  it('routes every job to a declared queue', () => {
    for (const name of registrar.handledJobNames()) {
      expect(QUEUES, name).toContain(registrar.queueOf(name));
    }
  });
});

describe('the correlation scope', () => {
  it('carries the id the enqueueing request had', async () => {
    const seen = await registrar.runWithJobScope({ correlationId: 'from-the-request' }, () =>
      Promise.resolve(correlationId()),
    );

    // A worker log line three hops from the click still ties back to it.
    expect(seen).toBe('from-the-request');
  });

  it('opens a fresh scope for a job that carries no id', async () => {
    const seen = await registrar.runWithJobScope({}, () => Promise.resolve(correlationId()));

    // A UUID -- what `newCorrelationId` produces, not the ULID the plan's test assumed.
    // Every line is attributable to something, even when the job came from a sweep rather
    // than a request.
    expect(seen).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refreshes settings before the next job scope', async () => {
    // The worker caches the organization at bootstrap and nothing in it observes the
    // settings changing. A studio that switches SMS reminders off through the office
    // screens keeps being billed for them until somebody restarts the worker — the API
    // refreshes on its own write, and the worker is a different process.
    const organizations = context.get(OrganizationContextService);
    // Flipped against what the container cached at bootstrap rather than set to a
    // literal: the seeded default is `false`, so asserting `false` would pass against a
    // worker that never refreshed anything.
    const cached = organizations.getSettings().smsRemindersEnabled;
    try {
      await prisma.organizationSettings.updateMany({ data: { smsRemindersEnabled: !cached } });

      const enabled = await registrar.runWithJobScope({}, () =>
        Promise.resolve(organizations.getSettings().smsRemindersEnabled),
      );

      expect(enabled).toBe(!cached);
    } finally {
      await prisma.organizationSettings.updateMany({ data: { smsRemindersEnabled: cached } });
      await organizations.refresh();
    }
  });

  it('runs with the last known settings when refresh fails', async () => {
    const organizations = context.get(OrganizationContextService);
    const cached = organizations.getSettings().smsRemindersEnabled;
    const refresh = vi
      .spyOn(organizations, 'refresh')
      .mockRejectedValueOnce(new Error('database temporarily unavailable'));

    try {
      const enabled = await registrar.runWithJobScope({}, () =>
        Promise.resolve(organizations.getSettings().smsRemindersEnabled),
      );

      expect(enabled).toBe(cached);
    } finally {
      refresh.mockRestore();
    }
  });

  it('does not leak the scope outside the job', async () => {
    await registrar.runWithJobScope({ correlationId: 'inside' }, () => Promise.resolve());

    expect(hasCorrelation()).toBe(false);
  });
});

describe('the maintenance schedule', () => {
  it('installs exactly the eight declared sweeps', async () => {
    await scheduler.install();

    const names = (await scheduler.installed()).map((entry) => entry.name).sort();

    expect(names).toEqual(
      [
        JOB.SWEEP_EXPIRED_RESERVATIONS,
        JOB.SWEEP_IDEMPOTENCY_KEYS,
        JOB.SWEEP_INBOX,
        JOB.SWEEP_NOTIFICATIONS,
        JOB.SWEEP_OUTBOX,
        JOB.SWEEP_REMINDERS,
        JOB.SWEEP_RETENTION,
        JOB.SWEEP_STUCK_EXPIRING,
      ].sort(),
    );
  });

  it('does not duplicate when installed twice', async () => {
    await scheduler.install();
    await scheduler.install();

    // `upsertJobScheduler` keyed on the job name, so every worker replica can install the
    // same schedule on every start without electing one to do it.
    expect(await scheduler.installed()).toHaveLength(SCHEDULE.length);
  });

  it('keeps the frequent sweeps on an interval and the nightly ones on a pattern', async () => {
    await scheduler.install();
    const installed = new Map((await scheduler.installed()).map((e) => [e.name, e]));

    // The two expiry sweeps bound how long a paid-for slot stays blocked by a reservation
    // that is over, which is why they are the fastest.
    expect(installed.get(JOB.SWEEP_EXPIRED_RESERVATIONS)?.every).toBe(60_000);
    expect(installed.get(JOB.SWEEP_STUCK_EXPIRING)?.every).toBe(60_000);
    expect(installed.get(JOB.SWEEP_INBOX)?.every).toBe(120_000);
    expect(installed.get(JOB.SWEEP_OUTBOX)?.every).toBe(300_000);
    expect(installed.get(JOB.SWEEP_NOTIFICATIONS)?.every).toBe(300_000);

    expect(installed.get(JOB.SWEEP_REMINDERS)?.pattern).toBe('0 3 * * *');
    expect(installed.get(JOB.SWEEP_IDEMPOTENCY_KEYS)?.pattern).toBe('15 3 * * *');
    expect(installed.get(JOB.SWEEP_RETENTION)?.pattern).toBe('30 3 * * *');
  });

  it('staggers the nightly sweeps rather than starting three at once', () => {
    const nightly = SCHEDULE.filter((entry) => entry.pattern !== undefined).map(
      (entry) => entry.pattern,
    );

    // They compete for the same database. Three starting together turns a quiet minute into
    // a spike for no benefit.
    expect(new Set(nightly).size).toBe(nightly.length);
  });

  it('produces a job whose name the router recognises', async () => {
    await scheduler.install();

    // The scheduler id defaults to the job name, but the router dispatches on the *job*
    // name — so the template sets it explicitly. A scheduler that produced jobs named after
    // their key would route nowhere and the queue would fill with discarded jobs.
    const names = (await scheduler.installed()).map((entry) => entry.name);
    const handled = registrar.handledJobNames();

    for (const name of names) expect(handled, name).toContain(name);
  });
});

describe('the process boundary', () => {
  it('finishes shutdown even when stale workers and connections reject close', async () => {
    const internals = registrar as unknown as {
      workers: Map<string, { close: () => Promise<void> }>;
      connections: { quit: () => Promise<unknown> }[];
    };

    internals.workers.set('stale', { close: () => Promise.reject(new Error('already closed')) });
    internals.connections.push({ quit: () => Promise.reject(new Error('connection gone')) });

    await expect(registrar.stop()).resolves.toBeUndefined();
  });

  it('has no http adapter', () => {
    // `createApplicationContext`, not `create`. A worker reachable through a load balancer
    // nobody meant to point at it is a worse outcome than one that cannot serve at all.
    expect((context as unknown as { httpAdapter?: unknown }).httpAdapter).toBeUndefined();
  });

  it('still resolves the queues, because a worker enqueues too', () => {
    // Reconcilers re-drive work by enqueueing it, so the registrar's own container needs
    // the same EnqueueService the API has.
    expect(context.get(EnqueueService).queue(QUEUE.MAINTENANCE)).toBeDefined();
  });

  it('is the mirror image of the api process, which registers no workers', async () => {
    const api = await NestFactory.createApplicationContext(AppModule, { logger: false });

    try {
      // Proven by the token not resolving. The API cannot pick up a job even if one is
      // waiting, which is what lets the two scale independently: API replicas for traffic,
      // worker replicas for backlog, neither competing with the other.
      expect(() => api.get(WorkerRegistrarService, { strict: false })).toThrow();
    } finally {
      await api.close();
    }
  }, 60_000);

  it('refuses to start when APP_ROLE is not worker', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', new URL('../../src/worker.main.ts', import.meta.url).pathname],
      {
        cwd: API_DIR,
        env: { ...process.env, APP_ROLE: 'api' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.resume();

    const [code] = (await once(child, 'exit')) as [number | null];

    // Two processes from one image differ only by this variable, which is what makes it
    // worth asserting before anything opens a connection.
    expect(code).toBe(1);
    expect(stderr).toContain('APP_ROLE');
  }, 60_000);
});
