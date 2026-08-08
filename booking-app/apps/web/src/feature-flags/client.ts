import { featureFlagClientConfigSchema } from '@shape-and-flow/booking-contracts';
import { UnleashClient } from 'unleash-proxy-client';
import { readonly, ref, type InjectionKey, type Ref } from 'vue';

import { api } from '../api/client.js';

import type { FeatureFlagClientConfig } from '@shape-and-flow/booking-contracts';
import type { IConfig } from 'unleash-proxy-client';

type Listener = (value?: unknown) => void;

export interface BrowserUnleashClient {
  start(): Promise<void>;
  stop(): void;
  isEnabled(name: string): boolean;
  on(event: 'ready' | 'update' | 'error', listener: Listener): void;
  off(event: 'ready' | 'update' | 'error', listener: Listener): void;
}

export type BrowserUnleashClientFactory = (config: IConfig) => BrowserUnleashClient;
export type FeatureFlagConfigLoader = () => Promise<FeatureFlagClientConfig>;

export interface FeatureFlagClient {
  readonly ready: Readonly<Ref<boolean>>;
  readonly version: Readonly<Ref<number>>;
  start(): Promise<void>;
  stop(): void;
  isEnabled(name: string, fallback?: boolean): boolean;
}

export const FEATURE_FLAG_CLIENT: InjectionKey<FeatureFlagClient> = Symbol('feature-flags');

const defaultFactory: BrowserUnleashClientFactory = (config) => new UnleashClient(config);

export function createFeatureFlagClient(
  loadConfig: FeatureFlagConfigLoader = () => api.public.featureFlagConfig(),
  factory: BrowserUnleashClientFactory = defaultFactory,
): FeatureFlagClient {
  const ready = ref(false);
  const version = ref(0);
  let sdk: BrowserUnleashClient | undefined;
  let startPromise: Promise<void> | undefined;

  const onReady = (): void => {
    ready.value = true;
    version.value += 1;
  };
  const onUpdate = (): void => {
    version.value += 1;
  };
  const onError = (error?: unknown): void => {
    console.warn('Unleash browser SDK error', error);
  };

  return {
    ready: readonly(ready),
    version: readonly(version),

    start(): Promise<void> {
      startPromise ??= (async () => {
        try {
          const config = featureFlagClientConfigSchema.parse(await loadConfig());
          sdk = factory({
            url: config.url,
            clientKey: config.clientKey,
            appName: config.appName,
            environment: config.environment,
            context: { properties: { deployment: config.deployment } },
          });
          sdk.on('ready', onReady);
          sdk.on('update', onUpdate);
          sdk.on('error', onError);
          await sdk.start();
        } catch (error) {
          console.warn('Feature flags are unavailable', error);
        }
      })();

      return startPromise;
    },

    stop(): void {
      if (!sdk) return;
      sdk.off('ready', onReady);
      sdk.off('update', onUpdate);
      sdk.off('error', onError);
      sdk.stop();
      sdk = undefined;
      ready.value = false;
    },

    isEnabled(name: string, fallback = false): boolean {
      if (!ready.value || !sdk) return fallback;

      try {
        return sdk.isEnabled(name);
      } catch (error) {
        console.warn('Unleash browser evaluation failed', error);
        return fallback;
      }
    },
  };
}
