import { Global, Module } from '@nestjs/common';
import { initialize } from 'unleash-client';

import { FeatureFlagsController } from './feature-flags.controller.js';
import {
  UNLEASH_CLIENT_FACTORY,
  FeatureFlagsService,
  type FeatureFlagClientFactory,
} from './feature-flags.service.js';

const createUnleashClient: FeatureFlagClientFactory = (config) => initialize(config);

@Global()
@Module({
  controllers: [FeatureFlagsController],
  providers: [
    FeatureFlagsService,
    { provide: UNLEASH_CLIENT_FACTORY, useValue: createUnleashClient },
  ],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
