import { errorCodeSchema } from '@shape-and-flow/booking-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../i18n/de.json';
import en from '../i18n/en.json';

import { api } from './client.js';
import { ApiError, messageKeyFor, NETWORK_ERROR } from './errors.js';

interface Call {
  url: string;
  init: RequestInit;
}

const calls: Call[] = [];
let responses: (() => Promise<Response> | Response)[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The next response the stub will hand out; queued so a retry can be observed. */
function queue(...next: (() => Promise<Response> | Response)[]): void {
  responses = [...responses, ...next];
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>;
}

const bookingBody = () => ({
  serviceId: 'cms9gryv30000ja32145w5gke',
  employeeId: 'cms9gryv30000ja32145w5gkf',
  startsAt: '2026-08-14T07:00:00.000Z',
  customer: {
    email: 'anna@example.com',
    firstName: 'Anna',
    lastName: 'Becker',
    locale: 'de' as const,
  },
  locale: 'de' as const,
  successUrl: 'http://localhost:3000/booking/success',
  cancelUrl: 'http://localhost:3000/booking/canceled',
});

beforeEach(() => {
  calls.length = 0;
  responses = [];

  vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    const next = responses.shift();
    if (next === undefined) throw new Error(`no queued response for ${input}`);
    return Promise.resolve(next());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the api client', () => {
  it('parses the error envelope into an ApiError carrying the code', async () => {
    queue(() => json({ code: 'SLOT_UNAVAILABLE', message: 'taken', correlationId: 'c1' }, 409));

    await expect(
      api.public.availability({ serviceId: 's', from: '2026-08-10', to: '2026-08-17' }),
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', correlationId: 'c1', status: 409 });
  });

  it('falls back to INTERNAL_ERROR for a body that is not the envelope', async () => {
    queue(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    queue(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    // A proxy timeout returns HTML. Parsing it as JSON is how a customer ends up reading
    // "Unexpected token < in JSON".
    await expect(api.public.services()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('keeps the code when the correlation id is missing', async () => {
    queue(() => json({ code: 'NOT_FOUND', message: 'x' }, 404));

    // The envelope contract requires a correlation id, but losing the actionable code because
    // a proxy stripped a support id would make the failure less useful, not safer.
    await expect(api.public.services()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      correlationId: undefined,
    });
  });

  it('falls back for a code this build does not know', async () => {
    queue(() => json({ code: 'SOMETHING_NEW', message: 'x' }, 409));

    // Passing it through would render an empty message, because there is no translation for it.
    await expect(api.public.services()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('sends the idempotency key header when creating a booking', async () => {
    queue(() => json({ bookingId: 'b' }, 201));

    await api.public.createBooking(bookingBody(), 'key-1');

    expect(headersOf(calls[0])['Idempotency-Key']).toBe('key-1');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('sends X-Requested-With on a mutation and credentials always', async () => {
    queue(() => json({ bookingId: 'b' }, 201));
    await api.public.createBooking(bookingBody(), 'key-1');

    // A cross-site form post cannot set a custom header, which is what makes its presence
    // evidence the request came from our own script.
    expect(headersOf(calls[0])['X-Requested-With']).toBe('XMLHttpRequest');
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('does not send X-Requested-With on a read', async () => {
    queue(() => json({ items: [] }));
    await api.public.services();

    expect(headersOf(calls[0])['X-Requested-With']).toBeUndefined();
  });

  it('sends a management token as a bearer header, never in the url', async () => {
    queue(() => json({ reference: 'SF-1' }));

    await api.manage.booking('tok-1');

    // A query parameter would land in the access log, the browser history and any Referer
    // header — three places a credential must not be.
    expect(calls[0]?.url).not.toContain('tok-1');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer tok-1');
  });

  it('keeps the token out of the url on every manage call', async () => {
    queue(
      () => json({ days: [] }),
      () => json({ status: 'CANCELED' }),
    );

    await api.manage.availability('tok-2', { from: '2026-08-10', to: '2026-08-17' });
    await api.manage.cancel('tok-2', {});

    for (const call of calls) expect(call.url).not.toContain('tok-2');
  });

  it('builds a query string and drops undefined values', async () => {
    queue(() => json({ days: [] }));

    await api.public.availability({
      serviceId: 's1',
      from: '2026-08-10',
      to: '2026-08-17',
      employeeId: undefined,
    });

    expect(calls[0]?.url).toBe(
      '/api/public/availability?serviceId=s1&from=2026-08-10&to=2026-08-17',
    );
  });

  it('retries a read once on a 5xx and returns the second answer', async () => {
    queue(
      () => json({ code: 'INTERNAL_ERROR', message: 'x' }, 503),
      () => json({ items: [1] }),
    );

    await expect(api.public.services()).resolves.toEqual({ items: [1] });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a read on a 4xx', async () => {
    queue(() => json({ code: 'NOT_FOUND', message: 'x' }, 404));

    // The server understood and refused; asking again gets the same answer.
    await expect(api.public.services()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });

  it('never retries a mutation, even a failed one', async () => {
    queue(() => json({ code: 'INTERNAL_ERROR', message: 'x' }, 503));

    // The idempotency key is per attempt, so a retry would consume the customer's one chance
    // to see the real error rather than protect them.
    await expect(api.public.createBooking(bookingBody(), 'key-1')).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it('carries Retry-After into the error, so the ui can say how long', async () => {
    queue(() => json({ code: 'RATE_LIMITED', message: 'slow down' }, 429, { 'retry-after': '30' }));

    await expect(api.public.services()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    });
  });

  it('propagates an abort as an abort, not as an api error', async () => {
    const controller = new AbortController();
    controller.abort();

    queue(() => {
      // What a real fetch does with an already-aborted signal.
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });

    // A component that navigated away is not looking at an error message.
    await expect(api.public.services(controller.signal)).rejects.toThrow(/abort/i);
  });

  it('returns undefined for a 204 rather than failing to parse it', async () => {
    queue(() => new Response(null, { status: 204 }));

    await expect(api.public.services()).resolves.toBeUndefined();
  });
});

describe('message keys', () => {
  it('maps every error code to a key that exists in both locales', () => {
    const german = de as Record<string, Record<string, string>>;
    const english = en as Record<string, Record<string, string>>;

    for (const code of errorCodeSchema.options) {
      const key = messageKeyFor(new ApiError({ code, status: 400 }));

      expect(key).toBe(`errors.${code}`);
      expect(german.errors?.[code], code).toBeTruthy();
      expect(english.errors?.[code], code).toBeTruthy();
    }
  });

  it('maps a non-api failure to the network message', () => {
    expect(messageKeyFor(new TypeError('Failed to fetch'))).toBe(`errors.${NETWORK_ERROR}`);
  });
});
