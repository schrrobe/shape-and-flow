import { describe, expect, it } from 'vitest';

import { runWithCorrelation } from '../correlation/correlation.store.js';

import { buildLoggerParams } from './logger.module.js';

import type { AppConfig } from '../../config/env.schema.js';

function paramsFor(overrides: Partial<AppConfig> = {}) {
  const config = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    LOG_SAMPLE_RATE: 1,
    ...overrides,
  } as AppConfig;

  const { pinoHttp } = buildLoggerParams(config);

  // The factory returns pino-http's own option union; this suite is about the
  // options object it builds, which is the only branch it ever produces.
  return pinoHttp as {
    level: string;
    customLogLevel: (request: unknown, response: { statusCode: number }, error?: Error) => string;
    customProps: (
      request: { method?: string; url?: string },
      response: { statusCode: number },
    ) => object;
    customSuccessObject: (
      request: unknown,
      response: { statusCode: number },
      val: object,
    ) => object;
    customErrorObject: (
      request: unknown,
      response: { statusCode: number },
      error: Error,
      val: object,
    ) => object;
    autoLogging: { ignore: (request: { url?: string }) => boolean };
    serializers: {
      req: (request: unknown) => object;
      res: (response: unknown) => object;
    };
  };
}

describe('buildLoggerParams', () => {
  it('takes its level from the configuration', () => {
    expect(paramsFor({ LOG_LEVEL: 'debug' }).level).toBe('debug');
  });

  it('levels the request line by its outcome', () => {
    const { customLogLevel } = paramsFor();

    expect(customLogLevel({}, { statusCode: 201 })).toBe('info');
    expect(customLogLevel({}, { statusCode: 404 })).toBe('warn');
    expect(customLogLevel({}, { statusCode: 500 })).toBe('error');
  });

  it('puts the method, path and correlation id on every line of a request', () => {
    const props = runWithCorrelation('corr-9', () =>
      paramsFor().customProps({ method: 'GET', url: '/api/public/catalog' }, { statusCode: 200 }),
    );

    expect(props).toEqual({
      method: 'GET',
      url: '/api/public/catalog',
      correlationId: 'corr-9',
    });
  });

  it('claims no status until the response has one', () => {
    // customProps decorates every line logged during the request, including the
    // exception filter's. Reading `res.statusCode` there reports the default 200 for
    // a request that is about to answer 401 — a log line that contradicts itself.
    const props = runWithCorrelation('corr-9', () =>
      paramsFor().customProps({ method: 'GET', url: '/x' }, { statusCode: 200 }),
    );

    expect(props).not.toHaveProperty('statusCode');
  });

  it('adds the status to the line that completes the request', () => {
    const line = paramsFor().customSuccessObject({}, { statusCode: 201 }, { msg: 'done' });

    expect(line).toEqual({ msg: 'done', statusCode: 201 });
  });

  it('adds the status to the line that completes a failed request', () => {
    const line = paramsFor().customErrorObject({}, { statusCode: 500 }, new Error('x'), {
      msg: 'failed',
    });

    expect(line).toEqual({ msg: 'failed', statusCode: 500 });
  });

  it('drops health probes and keeps ordinary requests', () => {
    const { autoLogging } = paramsFor();

    expect(autoLogging.ignore({ url: '/api/health/ready' })).toBe(true);
    expect(autoLogging.ignore({ url: '/api/public/bookings' })).toBe(false);
  });

  it('logs a request without its headers', () => {
    const { serializers } = paramsFor();

    expect(
      serializers.req({
        id: 'corr-3',
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.7',
        headers: { 'user-agent': 'Firefox/1', authorization: 'Bearer secret' },
      }),
    ).toEqual({
      id: 'corr-3',
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.7',
      userAgent: 'Firefox/1',
    });
  });

  it('logs a response without its headers, so a session cookie cannot reach the log', () => {
    // pino-http's default serializer emits every response header. On the login
    // route that includes `Set-Cookie`, which is a live session — a credential in
    // the log file is worse than the personal data the redaction list is aimed at.
    const line = paramsFor().serializers.res({
      statusCode: 200,
      getHeaders: () => ({ 'set-cookie': 'sf_office_session=a-real-session-id' }),
      headers: { 'set-cookie': 'sf_office_session=a-real-session-id' },
    });

    expect(line).toEqual({ statusCode: 200 });
    expect(JSON.stringify(line)).not.toContain('a-real-session-id');
  });

  it('honours the configured sample rate for availability', () => {
    // Rate 0 is the extreme that needs no randomness to assert: nothing survives it.
    expect(
      paramsFor({ LOG_SAMPLE_RATE: 0 }).autoLogging.ignore({ url: '/api/public/availability' }),
    ).toBe(true);

    expect(
      paramsFor({ LOG_SAMPLE_RATE: 1 }).autoLogging.ignore({ url: '/api/public/availability' }),
    ).toBe(false);
  });
});
