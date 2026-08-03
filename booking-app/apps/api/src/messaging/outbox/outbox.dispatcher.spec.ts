import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OUTBOX_DRAIN_INTERVAL_MS,
  OutboxDispatcherScheduler,
  outboxBackoffMs,
} from './outbox.dispatcher.js';

import type { OutboxDispatcher } from './outbox.dispatcher.js';
import type { AppConfig } from '../../config/env.schema.js';

/** A dispatcher whose drains can be resolved by hand, to control overlap. */
function controllableDispatcher(): {
  dispatcher: OutboxDispatcher;
  calls: number;
  finish: (count?: number) => void;
  fail: (message: string) => void;
} {
  const state = { calls: 0 };
  let settle: ((count: number) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  const dispatcher = {
    drainOnce: vi.fn(
      () =>
        new Promise<number>((resolve, rejectDrain) => {
          state.calls += 1;
          settle = resolve;
          reject = rejectDrain;
        }),
    ),
  } as unknown as OutboxDispatcher;

  return {
    dispatcher,
    get calls() {
      return state.calls;
    },
    finish: (count = 0) => settle?.(count),
    fail: (message: string) => reject?.(new Error(message)),
  };
}

const configFor = (role: 'api' | 'worker'): AppConfig => ({ APP_ROLE: role }) as AppConfig;

/** Let queued microtasks run, without advancing fake timers. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('outboxBackoffMs', () => {
  it('doubles per attempt from 30 seconds', () => {
    expect(outboxBackoffMs(0)).toBe(30_000);
    expect(outboxBackoffMs(1)).toBe(60_000);
    expect(outboxBackoffMs(2)).toBe(120_000);
  });

  it('caps at an hour rather than growing without bound', () => {
    expect(outboxBackoffMs(7)).toBe(3_600_000);
    expect(outboxBackoffMs(100)).toBe(3_600_000);
  });
});

describe('OutboxDispatcherScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
    };
  });

  it('does not drain in the api role', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('api'));

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS * 10);

    // A request-serving process must not be taking row locks on a schedule.
    expect(drains.calls).toBe(0);
    await scheduler.onApplicationShutdown();
  });

  it('drains on the interval in the worker role', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('worker'));

    scheduler.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(1);

    drains.finish(0);
    await flush();

    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(2);

    drains.finish(0);
    await scheduler.onApplicationShutdown();
  });

  it('does not start a second drain while one is still running', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('worker'));

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(1);

    // Several intervals pass while the first drain is still in flight. Two drains
    // from one process would compete for the same rows for no gain.
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS * 5);
    expect(drains.calls).toBe(1);

    drains.finish(3);
    await flush();

    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(2);

    drains.finish(0);
    await scheduler.onApplicationShutdown();
  });

  it('keeps draining after a failure instead of dying', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('worker'));

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);

    // An unhandled rejection here would take the worker down over a database blip.
    drains.fail('database went away');
    await flush();

    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(2);

    drains.finish(0);
    await scheduler.onApplicationShutdown();
  });

  it('waits for a drain in progress before shutting down', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('worker'));

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    expect(drains.calls).toBe(1);

    let finished = false;
    const shutdown = scheduler.onApplicationShutdown().then(() => {
      finished = true;
    });

    await flush();
    // Exiting mid-batch would leave the claimed rows locked until the connection
    // dropped, so shutdown has to wait for the transaction to finish.
    expect(finished).toBe(false);

    drains.finish(1);
    await shutdown;
    expect(finished).toBe(true);
  });

  it('stops draining once shut down', async () => {
    const drains = controllableDispatcher();
    const scheduler = new OutboxDispatcherScheduler(drains.dispatcher, configFor('worker'));

    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS);
    drains.finish(0);
    await flush();

    await scheduler.onApplicationShutdown();

    await vi.advanceTimersByTimeAsync(OUTBOX_DRAIN_INTERVAL_MS * 10);
    expect(drains.calls).toBe(1);
  });
});
