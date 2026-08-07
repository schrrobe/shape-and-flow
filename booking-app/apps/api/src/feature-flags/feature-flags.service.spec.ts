import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENV } from '../config/env.schema.js';

import {
  UNLEASH_CLIENT_FACTORY,
  FeatureFlagsService,
  type FeatureFlagClient,
  type FeatureFlagClientFactory,
} from './feature-flags.service.js';

import type { AppConfig } from '../config/env.schema.js';

const config = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    NODE_ENV: 'test',
    APP_ROLE: 'api',
    UNLEASH_URL: 'https://unleash.shapeandflow.de/api/',
    UNLEASH_BACKEND_TOKEN: 'backend-test-token',
    UNLEASH_FRONTEND_TOKEN: 'frontend-test-token',
    UNLEASH_ENVIRONMENT: 'development',
    UNLEASH_DEPLOYMENT: 'stage',
    ...overrides,
  }) as AppConfig;

const fakeClient = () => {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const client: FeatureFlagClient = {
    isEnabled: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return client;
    }),
    destroy: vi.fn(),
  };

  return { client, listeners };
};

async function createService(
  env: AppConfig,
  factory: FeatureFlagClientFactory,
): Promise<FeatureFlagsService> {
  const module = await Test.createTestingModule({
    providers: [
      FeatureFlagsService,
      { provide: ENV, useValue: env },
      { provide: UNLEASH_CLIENT_FACTORY, useValue: factory },
    ],
  }).compile();

  return module.get(FeatureFlagsService);
}

describe('FeatureFlagsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates one SDK client for repeated resolutions in one Nest process', async () => {
    const { client } = fakeClient();
    const factory = vi.fn<FeatureFlagClientFactory>().mockReturnValue(client);
    const module = await Test.createTestingModule({
      providers: [
        FeatureFlagsService,
        { provide: ENV, useValue: config() },
        { provide: UNLEASH_CLIENT_FACTORY, useValue: factory },
      ],
    }).compile();

    expect(module.get(FeatureFlagsService)).toBe(module.get(FeatureFlagsService));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['api', 'shape-and-flow-booking-api'],
    ['worker', 'shape-and-flow-booking-worker'],
  ] as const)('initializes the %s SDK with scoped configuration', async (role, appName) => {
    const { client } = fakeClient();
    const factory = vi.fn<FeatureFlagClientFactory>().mockReturnValue(client);

    await createService(config({ APP_ROLE: role }), factory);

    expect(factory).toHaveBeenCalledWith({
      appName,
      url: 'https://unleash.shapeandflow.de/api/',
      environment: 'development',
      customHeaders: { Authorization: 'backend-test-token' },
    });
  });

  it('merges deployment into caller context and forwards the explicit fallback', async () => {
    const { client } = fakeClient();
    const factory = vi.fn<FeatureFlagClientFactory>().mockReturnValue(client);
    const service = await createService(config(), factory);

    expect(
      service.isEnabled(
        'booking.new-flow',
        { userId: 'customer-1', properties: { locale: 'de' } },
        false,
      ),
    ).toBe(true);
    expect(client.isEnabled).toHaveBeenCalledWith(
      'booking.new-flow',
      { userId: 'customer-1', properties: { locale: 'de', deployment: 'stage' } },
      false,
    );
  });

  it('stays disabled and does not create a client when configuration is absent', async () => {
    const factory = vi.fn<FeatureFlagClientFactory>();
    const service = await createService(config({
      UNLEASH_URL: undefined,
      UNLEASH_BACKEND_TOKEN: undefined,
      UNLEASH_FRONTEND_TOKEN: undefined,
      UNLEASH_ENVIRONMENT: undefined,
      UNLEASH_DEPLOYMENT: undefined,
    }), factory);

    expect(service.isEnabled('booking.new-flow')).toBe(false);
    expect(service.isEnabled('booking.new-flow', {}, true)).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it('isolates startup errors and SDK error events', async () => {
    const startupError = new Error('cannot initialize');
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warningSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const service = await createService(config(), () => {
      throw startupError;
    });

    expect(service.isEnabled('booking.new-flow')).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('Unleash initialization failed', startupError.stack);

    const { client, listeners } = fakeClient();
    await createService(config(), () => client);
    const sdkError = new Error('poll failed');
    expect(() => listeners.get('error')?.[0]?.(sdkError)).not.toThrow();
    expect(() => listeners.get('warn')?.[0]?.('stale data')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('Unleash SDK error', sdkError.stack);
    expect(warningSpy).toHaveBeenCalledWith('Unleash SDK warning: stale data');
  });

  it('returns the fallback when SDK evaluation fails', async () => {
    const { client } = fakeClient();
    const sdkError = new Error('evaluation failed');
    vi.mocked(client.isEnabled).mockImplementation(() => {
      throw sdkError;
    });
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = await createService(config(), () => client);

    expect(service.isEnabled('booking.new-flow', {}, true)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Unleash evaluation failed', sdkError.stack);
  });

  it('destroys the SDK client during Nest shutdown', async () => {
    const { client } = fakeClient();
    const service = await createService(config(), () => client);

    service.onModuleDestroy();

    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
