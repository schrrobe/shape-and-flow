/**
 * The application's error type.
 *
 * Every failure that reaches a client does so as an AppError carrying a stable
 * machine-readable `code`. Clients switch on `code`, never on `message`, so copy
 * can change per locale without breaking behaviour.
 *
 * The full code-to-status table and the global exception filter arrive with the
 * contracts package; this is the minimum the domain needs in order to throw
 * meaningfully.
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
    this.status = options.status ?? 400;
    this.details = options.details;
  }
}

/** Narrowing helper for catch blocks. */
export function isAppError(error: unknown, code?: string): error is AppError {
  if (!(error instanceof AppError)) return false;
  return code === undefined || error.code === code;
}
