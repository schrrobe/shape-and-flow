import { describe, expect, it } from 'vitest';

import { InFlightRequests } from './inflight.js';
import { ShutdownService } from './shutdown.service.js';

import type { HttpAdapterHost } from '@nestjs/core';

/** The three methods a Node HTTP server owes a graceful stop. */
function fakeServer() {
  const calls = { close: 0, closeIdle: 0, closeAll: 0 };

  return {
    calls,
    server: {
      close: (done?: () => void) => {
        calls.close += 1;
        done?.();
      },
      closeIdleConnections: () => {
        calls.closeIdle += 1;
      },
      closeAllConnections: () => {
        calls.closeAll += 1;
      },
    },
  };
}

function hostFor(server: unknown): HttpAdapterHost {
  return {
    httpAdapter: { getHttpServer: () => server },
  } as unknown as HttpAdapterHost;
}

/** Short windows: this suite is about the decisions, not about waiting them out. */
const FAST = { drainTimeoutMs: 200, pollMs: 5 };

describe('ShutdownService', () => {
  it('stops the listener so no new connection is accepted', async () => {
    const { calls, server } = fakeServer();

    await new ShutdownService(
      hostFor(server),
      new InFlightRequests(),
      FAST,
    ).beforeApplicationShutdown('SIGTERM');

    expect(calls.close).toBe(1);
    // Keep-alive sockets with nothing on them would otherwise hold the close open
    // for their full timeout while doing no work.
    expect(calls.closeIdle).toBe(1);
  });

  it('waits for an in-flight request and lets it finish', async () => {
    const { calls, server } = fakeServer();
    const inFlight = new InFlightRequests();
    const service = new ShutdownService(hostFor(server), inFlight, FAST);

    inFlight.enter();
    const shutdown = service.beforeApplicationShutdown('SIGTERM');

    // Still draining: the request has not finished, so neither has the shutdown.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inFlight.count).toBe(1);

    inFlight.leave();
    await shutdown;

    // Nothing was cut off, so no connection needed destroying.
    expect(calls.closeAll).toBe(0);
  });

  it('gives up on a request that outlasts the drain window', async () => {
    const { calls, server } = fakeServer();
    const inFlight = new InFlightRequests();
    inFlight.enter();

    await new ShutdownService(hostFor(server), inFlight, {
      drainTimeoutMs: 30,
      pollMs: 5,
    }).beforeApplicationShutdown('SIGTERM');

    // A supervisor's SIGKILL is worse than a request we chose to end: it arrives
    // mid-write, with nothing said about why.
    expect(calls.closeAll).toBe(1);
  });

  it('does nothing when the process has no HTTP server', async () => {
    // The worker entrypoint builds an application context, not an application.
    const host = { httpAdapter: undefined } as unknown as HttpAdapterHost;

    await expect(
      new ShutdownService(host, new InFlightRequests(), FAST).beforeApplicationShutdown('SIGTERM'),
    ).resolves.toBeUndefined();
  });
});

describe('InFlightRequests', () => {
  it('counts a request from its start to its response', () => {
    const inFlight = new InFlightRequests();
    const response = { on: (_event: string, listener: () => void) => finish.push(listener) };
    const finish: (() => void)[] = [];

    inFlight.middleware({} as never, response as never, () => undefined);
    expect(inFlight.count).toBe(1);

    for (const listener of finish) listener();
    expect(inFlight.count).toBe(0);
  });

  it('counts a connection dropped mid-response as finished', () => {
    const inFlight = new InFlightRequests();
    const listeners = new Map<string, () => void>();
    const response = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };

    inFlight.middleware({} as never, response as never, () => undefined);
    // A client that goes away emits 'close' without ever emitting 'finish'; without
    // this the counter would never return to zero and every shutdown would hit its
    // timeout.
    listeners.get('close')?.();

    expect(inFlight.count).toBe(0);
  });

  it('decrements once even when both events fire', () => {
    const inFlight = new InFlightRequests();
    const listeners = new Map<string, () => void>();
    const response = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };

    inFlight.middleware({} as never, response as never, () => undefined);
    listeners.get('finish')?.();
    listeners.get('close')?.();

    expect(inFlight.count).toBe(0);
  });

  it('calls next, so the request continues', () => {
    let continued = false;

    new InFlightRequests().middleware({} as never, { on: () => undefined } as never, () => {
      continued = true;
    });

    expect(continued).toBe(true);
  });
});
