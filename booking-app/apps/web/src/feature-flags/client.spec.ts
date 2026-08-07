import { describe, expect, it, vi } from 'vitest';

import {
  createFeatureFlagClient,
  type BrowserUnleashClient,
  type BrowserUnleashClientFactory,
} from './client.js';

import type { FeatureFlagClientConfig } from '@shape-and-flow/booking-contracts';

const runtimeConfig: FeatureFlagClientConfig = {
  url: 'https://unleash.shapeandflow.de/api/frontend',
  clientKey: 'frontend-test-token',
  appName: 'shape-and-flow-booking-web',
  environment: 'development',
  deployment: 'stage',
};

const fakeSdk = () => {
  const listeners = new Map<string, ((value?: unknown) => void)[]>();
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  const isEnabled = vi.fn().mockReturnValue(true);
  const on = vi.fn((event: string, listener: (value?: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  });
  const off = vi.fn((event: string, listener: (value?: unknown) => void) => {
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
  });
  const sdk: BrowserUnleashClient = {
    start,
    stop,
    isEnabled,
    on,
    off,
  };
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };

  return { sdk, listeners, emit, start, stop, isEnabled, on, off };
};

describe('createFeatureFlagClient', () => {
  it('loads config first and creates and starts exactly one scoped SDK client', async () => {
    const order: string[] = [];
    const { sdk, start } = fakeSdk();
    start.mockImplementation(() => {
      order.push('start');
      return Promise.resolve();
    });
    const loadConfig = vi.fn(() => {
      order.push('config');
      return Promise.resolve(runtimeConfig);
    });
    const factory = vi.fn<BrowserUnleashClientFactory>().mockImplementation((sdkConfig) => {
      order.push('factory');
      expect(sdkConfig).toEqual({
        url: 'https://unleash.shapeandflow.de/api/frontend',
        clientKey: 'frontend-test-token',
        appName: 'shape-and-flow-booking-web',
        environment: 'development',
        context: { properties: { deployment: 'stage' } },
      });
      return sdk;
    });
    const client = createFeatureFlagClient(loadConfig, factory);

    await Promise.all([client.start(), client.start()]);

    expect(order).toEqual(['config', 'factory', 'start']);
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it('uses the fallback until ready and reacts to SDK updates', async () => {
    const { sdk, emit } = fakeSdk();
    const client = createFeatureFlagClient(() => Promise.resolve(runtimeConfig), () => sdk);

    await client.start();
    expect(client.isEnabled('booking.new-flow', false)).toBe(false);

    emit('ready');
    expect(client.ready.value).toBe(true);
    expect(client.isEnabled('booking.new-flow', false)).toBe(true);
    const version = client.version.value;

    emit('update');
    expect(client.version.value).toBe(version + 1);
  });

  it('keeps the app available when config loading or SDK evaluation fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createFeatureFlagClient(
      () => Promise.reject(new Error('network down')),
      vi.fn<BrowserUnleashClientFactory>(),
    );

    await expect(client.start()).resolves.toBeUndefined();
    expect(client.isEnabled('booking.new-flow', false)).toBe(false);
    expect(warning).toHaveBeenCalledOnce();

    const { sdk, emit, isEnabled } = fakeSdk();
    isEnabled.mockImplementation(() => {
      throw new Error('bad cache');
    });
    const evaluating = createFeatureFlagClient(() => Promise.resolve(runtimeConfig), () => sdk);
    await evaluating.start();
    emit('ready');
    expect(evaluating.isEnabled('booking.new-flow', true)).toBe(true);
  });

  it('detaches all SDK listeners and stops polling', async () => {
    const { sdk, listeners, off, stop } = fakeSdk();
    const client = createFeatureFlagClient(() => Promise.resolve(runtimeConfig), () => sdk);
    await client.start();

    client.stop();

    expect(off).toHaveBeenCalledTimes(3);
    expect([...listeners.values()].every((registered) => registered.length === 0)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
});
