import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runWithCorrelation } from '../correlation/correlation.store.js';

import { AppError } from './app-error.js';
import { GlobalExceptionFilter } from './global-exception.filter.js';

import type { ArgumentsHost } from '@nestjs/common';

/** A minimal ArgumentsHost that records what was sent. */
function hostFor() {
  // Typed so the recorded call tuples are not inferred as empty.
  const json = vi.fn<(body: Record<string, unknown>) => void>();
  const status = vi.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/x', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

const filter = new GlobalExceptionFilter();

function capture(
  exception: unknown,
  correlation = 'corr-test',
): {
  status: number;
  body: Record<string, unknown>;
} {
  const { host, status, json } = hostFor();
  runWithCorrelation(correlation, () => {
    filter.catch(exception, host);
  });

  const [statusCall] = status.mock.calls;
  const [jsonCall] = json.mock.calls;

  if (!statusCall || !jsonCall) throw new Error('filter did not respond');

  return { status: statusCall[0], body: jsonCall[0] };
}

describe('public AppErrors', () => {
  it('maps a code to its documented status and passes details through', () => {
    const { status, body } = capture(
      new AppError('SLOT_UNAVAILABLE', {
        message: 'That time is no longer available.',
        details: { employeeId: 'emp-1' },
      }),
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      message: 'That time is no longer available.',
      details: { employeeId: 'emp-1' },
    });
  });

  it('derives the status from the code without being told', () => {
    expect(capture(new AppError('NOT_FOUND')).status).toBe(404);
    expect(capture(new AppError('IDEMPOTENCY_KEY_REUSED')).status).toBe(422);
    expect(capture(new AppError('RATE_LIMITED')).status).toBe(429);
    expect(capture(new AppError('UNAUTHENTICATED')).status).toBe(401);
  });

  it('omits details entirely when there are none', () => {
    const { body } = capture(new AppError('NOT_FOUND', { message: 'Resource not found.' }));
    expect(Object.keys(body).sort()).toEqual(['code', 'correlationId', 'message']);
    expect('details' in body).toBe(false);
  });
});

describe('internal AppErrors', () => {
  it('becomes a generic 500 and leaks neither the code nor the message', () => {
    // An internal invariant broke. The client must learn nothing from it.
    const { status, body } = capture(
      new AppError('UNSCOPED_TENANT_QUERY', {
        message: 'Booking.findMany requires organizationId in its where clause.',
      }),
    );

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('UNSCOPED_TENANT_QUERY');
    expect(JSON.stringify(body)).not.toContain('organizationId');
  });

  it('does the same for every internal domain code', () => {
    for (const code of [
      'INVALID_MONEY',
      'CURRENCY_MISMATCH',
      'INVALID_PERCENTAGE',
      'INVALID_LOCAL_TIME',
    ]) {
      const { status, body } = capture(new AppError(code, { message: `leaky ${code}` }));
      expect(status, code).toBe(500);
      expect(body.code, code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body), code).not.toContain(code);
    }
  });
});

describe('ZodError', () => {
  it('becomes 400 VALIDATION_FAILED carrying the field paths', () => {
    const result = z
      .object({ serviceId: z.string(), startsAt: z.string() })
      .safeParse({ startsAt: 42 });

    const { status, body } = capture(result.error);
    const details = body.details as { issues: { path: unknown[] }[] };

    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(details.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([['serviceId'], ['startsAt']]),
    );
  });

  it('reports every issue, not only the first', () => {
    const result = z.object({ a: z.string(), b: z.string(), c: z.string() }).safeParse({});
    const details = capture(result.error).body.details as { issues: unknown[] };
    expect(details.issues).toHaveLength(3);
  });
});

describe('HttpException', () => {
  it('maps Nest statuses to public codes', () => {
    expect(capture(new HttpException('nope', 404)).body.code).toBe('NOT_FOUND');
    expect(capture(new HttpException('nope', 401)).body.code).toBe('UNAUTHENTICATED');
    expect(capture(new HttpException('nope', 403)).body.code).toBe('FORBIDDEN_ROLE');
    expect(capture(new HttpException('nope', 429)).body.code).toBe('RATE_LIMITED');
  });

  it('keeps a 4xx message but replaces a 5xx one', () => {
    expect(capture(new HttpException('Route not found', 404)).body.message).toBe('Route not found');
    const server = capture(new HttpException('upstream exploded at 10.0.0.5', 502));
    expect(server.status).toBe(502);
    expect(JSON.stringify(server.body)).not.toContain('10.0.0.5');
  });
});

describe('unknown exceptions', () => {
  it('never leaks an internal message', () => {
    const { status, body } = capture(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('survives a thrown non-Error', () => {
    expect(capture('a bare string').status).toBe(500);
    expect(capture(undefined).body.code).toBe('INTERNAL_ERROR');
  });
});

describe('the envelope', () => {
  it('always carries the active correlation id', () => {
    expect(capture(new AppError('NOT_FOUND'), 'corr-abc').body.correlationId).toBe('corr-abc');
    expect(capture(new Error('boom'), 'corr-xyz').body.correlationId).toBe('corr-xyz');
  });

  it('falls back to a placeholder outside a correlation scope', () => {
    // A logger or a filter must never be the thing that fails a request.
    const { host, json } = hostFor();
    filter.catch(new AppError('NOT_FOUND'), host);
    expect(json.mock.calls[0]?.[0].correlationId).toBe('-');
  });

  it('has exactly the documented keys for every exception kind', () => {
    for (const exception of [
      new AppError('SLOT_UNAVAILABLE'),
      new AppError('INVALID_MONEY'),
      new HttpException('nope', 404),
      new Error('boom'),
    ]) {
      const keys = Object.keys(capture(exception).body).sort();
      expect(
        keys.filter((key) => !['code', 'message', 'details', 'correlationId'].includes(key)),
      ).toEqual([]);
      expect(keys).toContain('code');
      expect(keys).toContain('message');
      expect(keys).toContain('correlationId');
    }
  });
});
