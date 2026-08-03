import { Catch, HttpException, Logger } from '@nestjs/common';
import { ZodError } from 'zod';

import { correlationId } from '../correlation/correlation.store.js';

import { AppError } from './app-error.js';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ErrorCode, ErrorEnvelope } from '@shape-and-flow/booking-contracts';
import type { Response } from 'express';

/**
 * Turns every failure into the one documented envelope.
 *
 * Three rules make this safe:
 *
 *  - An internal message never reaches a client. Anything that is not a public
 *    error code becomes a generic 500, and the real code and message are logged
 *    with the correlation id instead.
 *  - The envelope keys are fixed. `details` appears only when there is something
 *    structured to say, so a client can rely on the shape.
 *  - 4xx logs at warn and 5xx at error, because a customer hitting a taken slot is
 *    not an incident and a broken invariant is.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, envelope, logged } = describe(exception);

    if (status >= 500) {
      this.logger.error(
        `${String(status)} ${logged.code}: ${logged.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${String(status)} ${logged.code}: ${logged.message}`);
    }

    response.status(status).json(envelope);
  }
}

interface Described {
  status: number;
  envelope: ErrorEnvelope;
  /** What goes to the log, which may say more than the response does. */
  logged: { code: string; message: string };
}

const GENERIC_MESSAGE = 'An unexpected error occurred.';

/** HTTP statuses Nest raises on its own behalf, mapped to public codes. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN_ROLE';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
  }
}

function envelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  // Built key by key rather than spread, so `details` is absent — not undefined —
  // when there is nothing to report.
  const base: ErrorEnvelope = { code, message, correlationId: correlationId() };
  return details === undefined ? base : { ...base, details };
}

function describe(exception: unknown): Described {
  if (exception instanceof ZodError) {
    const details = {
      issues: exception.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    };

    return {
      status: 400,
      envelope: envelope('VALIDATION_FAILED', 'Request validation failed.', details),
      logged: { code: 'VALIDATION_FAILED', message: `${String(exception.issues.length)} issue(s)` },
    };
  }

  if (exception instanceof AppError) {
    if (exception.isPublic()) {
      return {
        status: exception.status,
        envelope: envelope(exception.code as ErrorCode, exception.message, exception.details),
        logged: { code: exception.code, message: exception.message },
      };
    }

    // An internal invariant broke. The client learns nothing; the log learns
    // everything.
    return {
      status: 500,
      envelope: envelope('INTERNAL_ERROR', GENERIC_MESSAGE),
      logged: { code: exception.code, message: exception.message },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = codeForStatus(status);

    return {
      status,
      envelope: envelope(code, status >= 500 ? GENERIC_MESSAGE : exception.message),
      logged: { code, message: exception.message },
    };
  }

  return {
    status: 500,
    envelope: envelope('INTERNAL_ERROR', GENERIC_MESSAGE),
    logged: {
      code: 'INTERNAL_ERROR',
      message: exception instanceof Error ? exception.message : String(exception),
    },
  };
}
