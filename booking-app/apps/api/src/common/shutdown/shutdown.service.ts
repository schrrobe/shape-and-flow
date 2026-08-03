import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { CLOCK } from '../../domain/time/clock.js';

import { InFlightRequests } from './inflight.js';

import type { Clock } from '../../domain/time/clock.js';
import type { BeforeApplicationShutdown } from '@nestjs/common';

/**
 * How long in-flight requests may take before they are ended.
 *
 * Below the grace period an orchestrator gives before SIGKILL — 30 seconds for
 * Docker and Kubernetes both — so the process finishes its own work rather than
 * being killed halfway through somebody's payment.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

/** How often the drain checks whether the last request has finished. */
const DRAIN_POLL_MS = 100;

/** A Node HTTP server, in the three methods a graceful stop uses. */
interface ClosableServer {
  close: (done?: () => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownOptions {
  drainTimeoutMs: number;
  pollMs: number;
}

/**
 * Stop serving, then finish what was already being served.
 *
 * `beforeApplicationShutdown` is the hook that runs before Nest disposes anything,
 * which is the only point at which the listener can be closed while the container
 * that answers requests is still intact. Nest's own `dispose()` closes the server
 * too, but it does so without waiting for requests and without saying anything —
 * and a shutdown nobody can read is a shutdown nobody can debug.
 *
 * Redis and Prisma are deliberately not touched here. They already close through
 * their own `onApplicationShutdown` hooks, which Nest runs after this one, so
 * closing them here would mean two owners for one socket.
 */
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Shutdown');
  private readonly options: ShutdownOptions;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly inFlight: InFlightRequests,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() options?: ShutdownOptions,
  ) {
    this.options = options ?? {
      drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
      pollMs: DRAIN_POLL_MS,
    };
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const server = this.httpServer();

    // The worker builds an application context, which has no server to stop.
    if (server === null) return;

    this.logger.log(`${signal ?? 'shutdown'}: closing the listener`);

    // Stops accepting new connections. Existing ones keep going, which is the
    // difference between draining and dropping.
    server.close();
    // Keep-alive sockets sitting idle would otherwise hold the close open for their
    // full timeout while carrying no work at all.
    server.closeIdleConnections?.();

    const started = this.inFlight.count;
    if (started > 0) {
      this.logger.log(`waiting for ${String(started)} in-flight request(s)`);
    }

    const drained = await this.drain();

    if (drained) {
      this.logger.log('all requests finished; handing back to Nest');
      return;
    }

    this.logger.warn(
      `${String(this.inFlight.count)} request(s) did not finish within ` +
        `${String(this.options.drainTimeoutMs)}ms; closing their connections`,
    );
    // Ending them ourselves, now, with a log line saying so. The alternative is the
    // supervisor's SIGKILL arriving mid-write with nothing recorded about why.
    server.closeAllConnections?.();
  }

  /** True when everything finished, false when the window ran out. */
  private async drain(): Promise<boolean> {
    // Against the clock, not against a count of polls. `setTimeout` promises a lower
    // bound only, and a shutting-down event loop is a busy one, so summing `pollMs`
    // undercounts — by enough over 250 iterations to push the drain past the grace
    // period and let SIGKILL arrive before `closeAllConnections()` ever runs.
    const deadline = this.clock.now().getTime() + this.options.drainTimeoutMs;

    while (this.inFlight.count > 0 && this.clock.now().getTime() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
    }

    return this.inFlight.count === 0;
  }

  private httpServer(): ClosableServer | null {
    const adapter = this.adapterHost.httpAdapter as
      { getHttpServer: () => ClosableServer | undefined } | undefined;

    return adapter?.getHttpServer() ?? null;
  }
}
