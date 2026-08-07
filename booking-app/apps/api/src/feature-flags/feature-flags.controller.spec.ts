import 'reflect-metadata';

import { ServiceUnavailableException } from '@nestjs/common';
import { featureFlagClientConfigSchema } from '@shape-and-flow/booking-contracts';
import { describe, expect, it } from 'vitest';

import { IS_PUBLIC } from '../common/guards/public.decorator.js';

import { FeatureFlagsController } from './feature-flags.controller.js';

import type { AppConfig } from '../config/env.schema.js';

describe('FeatureFlagsController', () => {
  it('returns only schema-validated browser configuration', () => {
    const controller = new FeatureFlagsController({
      UNLEASH_URL: 'https://unleash.shapeandflow.de/api/',
      UNLEASH_FRONTEND_TOKEN: 'frontend-test-token',
      UNLEASH_ENVIRONMENT: 'development',
      UNLEASH_DEPLOYMENT: 'stage',
    } as AppConfig);

    const response = controller.config();

    expect(featureFlagClientConfigSchema.parse(response)).toEqual({
      url: 'https://unleash.shapeandflow.de/api/frontend',
      clientKey: 'frontend-test-token',
      appName: 'shape-and-flow-booking-web',
      environment: 'development',
      deployment: 'stage',
    });
    expect(response).not.toHaveProperty('backendToken');
  });

  it('preserves the base path when UNLEASH_URL has no trailing slash', () => {
    const controller = new FeatureFlagsController({
      UNLEASH_URL: 'https://unleash.shapeandflow.de/api',
      UNLEASH_FRONTEND_TOKEN: 'frontend-test-token',
      UNLEASH_ENVIRONMENT: 'development',
      UNLEASH_DEPLOYMENT: 'stage',
    } as AppConfig);

    expect(controller.config()).toMatchObject({
      url: 'https://unleash.shapeandflow.de/api/frontend',
    });
  });

  it('fails closed when browser configuration is absent', () => {
    const controller = new FeatureFlagsController({ NODE_ENV: 'test' } as AppConfig);

    expect(() => controller.config()).toThrow(ServiceUnavailableException);
  });

  it('marks the runtime endpoint as public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC, FeatureFlagsController)).toBe(true);
  });
});
