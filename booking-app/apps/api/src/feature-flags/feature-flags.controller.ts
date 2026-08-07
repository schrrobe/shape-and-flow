import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import {
  featureFlagClientConfigSchema,
  type FeatureFlagClientConfig,
} from '@shape-and-flow/booking-contracts';

import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';

import type { AppConfig } from '../config/env.schema.js';

@Controller('public/feature-flags')
@Public()
export class FeatureFlagsController {
  constructor(@Inject(ENV) private readonly env: AppConfig) {}

  @Get('config')
  config(): FeatureFlagClientConfig {
    const { UNLEASH_URL, UNLEASH_FRONTEND_TOKEN, UNLEASH_ENVIRONMENT, UNLEASH_DEPLOYMENT } =
      this.env;

    if (!UNLEASH_URL || !UNLEASH_FRONTEND_TOKEN || !UNLEASH_ENVIRONMENT || !UNLEASH_DEPLOYMENT) {
      throw new ServiceUnavailableException('Feature flags are not configured');
    }

    const unleashUrl = new URL(UNLEASH_URL);
    unleashUrl.pathname = `${unleashUrl.pathname.replace(/\/$/, '')}/`;

    return featureFlagClientConfigSchema.parse({
      url: new URL('frontend', unleashUrl).toString(),
      clientKey: UNLEASH_FRONTEND_TOKEN,
      appName: 'shape-and-flow-booking-web',
      environment: UNLEASH_ENVIRONMENT,
      deployment: UNLEASH_DEPLOYMENT,
    });
  }
}
