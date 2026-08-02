import { describe, expect, it } from 'vitest';

import { runWithCorrelation } from '../correlation/correlation.store.js';

import { requestLogLevel, requestLogProps, shouldSkipRequestLog } from './request-log.js';

describe('requestLogLevel', () => {
  it('logs a served request at info', () => {
    expect(requestLogLevel(200)).toBe('info');
    expect(requestLogLevel(201)).toBe('info');
    expect(requestLogLevel(302)).toBe('info');
  });

  it('logs a rejected request at warn', () => {
    // A customer hitting a taken slot, an expired session, a rate limit: all
    // ordinary, none of them an incident. Same rule the exception filter uses.
    expect(requestLogLevel(400)).toBe('warn');
    expect(requestLogLevel(401)).toBe('warn');
    expect(requestLogLevel(429)).toBe('warn');
  });

  it('logs a failed request at error', () => {
    expect(requestLogLevel(500)).toBe('error');
    expect(requestLogLevel(503)).toBe('error');
  });

  it('logs a transport-level failure at error whatever the status says', () => {
    // A socket that died mid-response leaves the status at 200.
    expect(requestLogLevel(200, new Error('aborted'))).toBe('error');
  });
});

describe('shouldSkipRequestLog', () => {
  const never = (): number => 0;

  it('keeps an ordinary request', () => {
    expect(shouldSkipRequestLog('/api/public/bookings', 1, never)).toBe(false);
  });

  it('drops a health probe, which a supervisor sends every few seconds', () => {
    expect(shouldSkipRequestLog('/api/health/live', 1, never)).toBe(true);
    expect(shouldSkipRequestLog('/api/health/ready', 1, never)).toBe(true);
  });

  it('keeps every availability request at the default sample rate', () => {
    expect(shouldSkipRequestLog('/api/public/availability?from=2026-08-01', 1, () => 0.99)).toBe(
      false,
    );
  });

  it('drops the sampled-out share of availability requests', () => {
    // The one endpoint a browsing customer hits on every date change, and the only
    // one that can dominate a day's log volume on its own.
    expect(shouldSkipRequestLog('/api/public/availability', 0.1, () => 0.5)).toBe(true);
    expect(shouldSkipRequestLog('/api/public/availability', 0.1, () => 0.05)).toBe(false);
  });

  it('never samples out anything else, however low the rate', () => {
    // Sampling a booking or a webhook would lose the request an investigation starts from.
    expect(shouldSkipRequestLog('/api/public/bookings', 0.01, () => 0.99)).toBe(false);
    expect(shouldSkipRequestLog('/api/webhooks/stripe', 0.01, () => 0.99)).toBe(false);
  });
});

describe('requestLogProps', () => {
  it('names the request and the correlation id', () => {
    const props = runWithCorrelation('corr-1', () =>
      requestLogProps({ method: 'POST', url: '/api/public/bookings' }),
    );

    expect(props).toEqual({
      method: 'POST',
      url: '/api/public/bookings',
      correlationId: 'corr-1',
    });
  });

  it('survives a request Node could not attribute', () => {
    const props = runWithCorrelation('corr-2', () =>
      requestLogProps({ method: undefined, url: undefined }),
    );

    expect(props).toEqual({
      method: '-',
      url: '-',
      correlationId: 'corr-2',
    });
  });
});
