import { Injectable } from '@nestjs/common';

import type { NextFunction, Request, Response } from 'express';

/**
 * How many requests are currently being served.
 *
 * A graceful stop has to know when the work is done, and the HTTP server cannot say:
 * `server.close()` waits for *connections* to end, and a keep-alive connection with
 * nothing on it is idle rather than finished. Counting requests answers the question
 * that matters — "is anyone still waiting for an answer?" — which is what decides
 * whether the process may exit.
 */
@Injectable()
export class InFlightRequests {
  private inFlight = 0;

  get count(): number {
    return this.inFlight;
  }

  /** For tests and for callers that are not an HTTP request. */
  enter(): void {
    this.inFlight += 1;
  }

  leave(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /**
   * Mounted with `app.use()` before everything else, like the correlation
   * middleware: a request rejected by a guard is still a request being served, and
   * ending it under the client is exactly what a graceful stop is meant to avoid.
   */
  middleware = (_request: Request, response: Response, next: NextFunction): void => {
    this.enter();

    // Both events, once. A client that disconnects mid-response emits `close`
    // without ever emitting `finish`, and a counter that never returns to zero
    // would make every shutdown wait out its full timeout.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.leave();
    };

    response.on('finish', finish);
    response.on('close', finish);

    next();
  };
}
