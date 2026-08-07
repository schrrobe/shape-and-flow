import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Context, UnleashConfig } from 'unleash-client';

export const UNLEASH_CLIENT_FACTORY = Symbol('UNLEASH_CLIENT_FACTORY');

export interface FeatureFlagClient {
  isEnabled(name: string, context?: Context, fallbackValue?: boolean): boolean;
  on(event: 'error' | 'warn', listener: (value: unknown) => void): this;
  destroy(): void;
}

export type FeatureFlagClientFactory = (config: UnleashConfig) => FeatureFlagClient;

@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly deployment: AppConfig['UNLEASH_DEPLOYMENT'];
  private client: FeatureFlagClient | undefined;

  constructor(
    @Inject(ENV) env: AppConfig,
    @Inject(UNLEASH_CLIENT_FACTORY) factory: FeatureFlagClientFactory,
  ) {
    this.deployment = env.UNLEASH_DEPLOYMENT;

    if (
      !env.UNLEASH_URL ||
      !env.UNLEASH_BACKEND_TOKEN ||
      !env.UNLEASH_ENVIRONMENT ||
      !env.UNLEASH_DEPLOYMENT
    ) {
      return;
    }

    try {
      this.client = factory({
        appName:
          env.APP_ROLE === 'worker'
            ? 'shape-and-flow-booking-worker'
            : 'shape-and-flow-booking-api',
        url: env.UNLEASH_URL,
        environment: env.UNLEASH_ENVIRONMENT,
        customHeaders: { Authorization: env.UNLEASH_BACKEND_TOKEN },
      });
      this.client.on('error', (error) => {
        this.logError('Unleash SDK error', error);
      });
      this.client.on('warn', (warning) => {
        this.logger.warn(`Unleash SDK warning: ${String(warning)}`);
      });
    } catch (error) {
      this.logError('Unleash initialization failed', error);
    }
  }

  isEnabled(name: string, context: Context = {}, fallback = false): boolean {
    if (!this.client || !this.deployment) return fallback;

    try {
      return this.client.isEnabled(
        name,
        {
          ...context,
          properties: {
            ...context.properties,
            deployment: this.deployment,
          },
        },
        fallback,
      );
    } catch (error) {
      this.logError('Unleash evaluation failed', error);
      return fallback;
    }
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(message, error.stack);
      return;
    }

    this.logger.error(`${message}: ${String(error)}`);
  }
}
