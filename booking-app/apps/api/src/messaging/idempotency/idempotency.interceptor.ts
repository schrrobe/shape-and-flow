import { Injectable } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { catchError, concatMap, from, of, throwError } from 'rxjs';

import { AppError } from '../../common/errors/app-error.js';
import { OrganizationContextService } from '../../organization/organization-context.service.js';

import { IdempotencyService } from './idempotency.service.js';
import { IDEMPOTENCY_SCOPE } from './idempotent.decorator.js';
import { canonicalRequestHash } from './request-hash.js';

import type { IdempotencyScope } from './idempotent.decorator.js';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

/** RFC 4122 shape, matching `idempotencyKeySchema` in the contracts package. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Set on a replayed response, so a client or an operator can see it was not re-run. */
const REPLAY_HEADER = 'idempotent-replay';

function readKey(request: Request): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;

  if (key === undefined || !UUID.test(key)) {
    throw new AppError('VALIDATION_FAILED', {
      status: 400,
      message: 'Idempotency-Key header is required and must be a UUID.',
      // The value is deliberately absent from the response and from this error: it
      // is a credential, and an error envelope is not a place to echo one.
      details: { header: 'Idempotency-Key' },
    });
  }

  return key;
}

/**
 * Applies the idempotency contract to any route marked with `@Idempotent`.
 *
 * Sits in front of the handler, not inside it, so a handler never has to remember
 * any of this. What it guarantees: the same key and body replay the first response
 * byte for byte; the same key with a different body or scope is refused; a request
 * still in flight is refused rather than run twice; and a failed attempt leaves the
 * key free, so the client's retry actually retries.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
    private readonly organizations: OrganizationContextService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const scope = this.reflector.get<IdempotencyScope | undefined>(
      IDEMPOTENCY_SCOPE,
      context.getHandler(),
    );

    if (scope === undefined) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const key = readKey(request);

    // Hashed from the parsed body and route target, before validation has narrowed them.
    // The params matter: canceling two bookings with the same reason is not the same
    // operation, and one key must never replay the first booking's response for the second.
    const requestHash = canonicalRequestHash(request.body, request.params);

    const begun = await this.idempotency.begin(key, scope, requestHash);

    switch (begun.outcome) {
      case 'REPLAY':
        response.status(begun.statusCode);
        response.setHeader(REPLAY_HEADER, 'true');
        return of(begun.body);

      case 'MISMATCH':
        throw new AppError('IDEMPOTENCY_KEY_REUSED', {
          message:
            'This Idempotency-Key was already used for a different request. ' +
            'Use a new key, or retry the original request unchanged.',
        });

      case 'IN_PROGRESS':
        throw new AppError('IDEMPOTENT_REQUEST_IN_PROGRESS', {
          message: 'A request with this Idempotency-Key is still being processed.',
        });

      case 'NEW':
        break;
    }

    const statusCode = this.successStatus(context, request);

    return next.handle().pipe(
      catchError((error: unknown) =>
        // Nothing is stored when the handler fails. A stored 500 would replay
        // forever and the client's retry would never actually retry.
        from(this.idempotency.abandon(key)).pipe(concatMap(() => throwError(() => error))),
      ),
      // concatMap rather than tap: the snapshot has to be committed before the
      // response is emitted, or a client fast enough to retry could be told the
      // attempt is still in progress after it has actually finished.
      concatMap(async (body: unknown) => {
        await this.idempotency.complete(key, statusCode, body, {
          organizationId: this.organizations.getOrganizationId(),
          ...bookingIdOf(body),
        });
        return body;
      }),
    );
  }

  /**
   * The status a successful handler will produce.
   *
   * Read from the route rather than from `response.statusCode`, which Nest has not
   * set yet at this point in the pipeline. This mirrors Nest's own rule: an explicit
   * `@HttpCode` wins, otherwise POST is 201 and everything else is 200.
   */
  private successStatus(context: ExecutionContext, request: Request): number {
    const declared = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );

    return declared ?? (request.method === 'POST' ? 201 : 200);
  }
}

/** Pull a booking id out of a response body, so a key can be traced to its booking. */
function bookingIdOf(body: unknown): { bookingId?: string } {
  if (body === null || typeof body !== 'object') return {};

  const candidate = (body as { bookingId?: unknown }).bookingId;
  return typeof candidate === 'string' ? { bookingId: candidate } : {};
}
