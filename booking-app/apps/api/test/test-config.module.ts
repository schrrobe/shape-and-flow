import { Global, Module } from '@nestjs/common';

import { ENV } from '../src/config/env.schema.js';

import type { AppConfig } from '../src/config/env.schema.js';

/**
 * Configuration for an integration test that boots a real Nest container.
 *
 * Deliberately not the real ConfigModule. That one parses the whole environment
 * and exits the process when a variable is missing, so a test of queue wiring
 * would fail over an unrelated absent variable — and `process.exit` inside a test
 * worker is a poor diagnostic. Only what the modules under test read is provided.
 *
 * The cast is the honest shape of this: the object is a partial AppConfig standing
 * in for the full one. A module that reaches for a variable not listed here gets
 * `undefined` and fails loudly, which is the intended signal to add it.
 *
 * Global for the same reason ConfigModule is: modules resolve ENV without
 * importing anything.
 */
const TEST_CONFIG = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_QUEUE_PREFIX: process.env.REDIS_QUEUE_PREFIX,
} as unknown as AppConfig;

@Global()
@Module({
  providers: [{ provide: ENV, useValue: TEST_CONFIG }],
  exports: [ENV],
})
export class TestConfigModule {}
