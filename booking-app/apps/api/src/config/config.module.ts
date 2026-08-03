import { Global, Module } from '@nestjs/common';

import { ENV, loadConfig } from './env.schema.js';

import type { AppConfig } from './env.schema.js';

/**
 * Parses and validates the environment exactly once, then exposes the result
 * under the ENV token. Global so no feature module has to import it.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
