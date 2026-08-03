import { ERROR_STATUS, isPublicErrorCode } from '@shape-and-flow/booking-contracts';

/**
 * The application's error type.
 *
 * Two kinds of code travel in here, on purpose:
 *
 *  - A **public** code from the contracts package, which reaches the client along
 *    with its documented status.
 *  - An **internal** code for an invariant violation — a fractional cent, an
 *    unscoped tenant query — which the exception filter turns into a generic 500
 *    while logging the real code. Adding a code to the public set is therefore a
 *    deliberate act, not something that happens by forgetting.
 *
 * The status defaults from the public table, so call sites rarely pass one.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    options: { message?: string; status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(options.message ?? code, options.cause === undefined ? {} : { cause: options.cause });

    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.status =
      options.status ?? (isPublicErrorCode(code) ? ERROR_STATUS[code] : /* internal */ 500);
  }

  /** True when this error is safe to describe to a client verbatim. */
  isPublic(): boolean {
    return isPublicErrorCode(this.code);
  }
}

/** Narrowing helper for catch blocks. */
export function isAppError(error: unknown, code?: string): error is AppError {
  if (!(error instanceof AppError)) return false;
  return code === undefined || error.code === code;
}
