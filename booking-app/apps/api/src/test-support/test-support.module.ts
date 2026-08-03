import { Logger, Module } from '@nestjs/common';

import { BookingModule } from '../booking/booking.module.js';

import { TestSupportController } from './test-support.controller.js';
import { TestSupportService } from './test-support.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { OnApplicationBootstrap } from '@nestjs/common';

/**
 * A router that resets databases and marks payments received.
 *
 * Three independent things keep it away from anything real, because one would not
 * be enough for a router with these powers:
 *
 *  1. `ENABLE_TEST_SUPPORT` defaults to false, and the environment schema rejects
 *     the configuration outright when it is true and NODE_ENV is production. The
 *     process does not start.
 *  2. This module is *absent* from the container unless the flag is on — see
 *     {@link testSupportImports}. Not a guard that answers 404: no controller, no
 *     route, no service instance, nothing to reach.
 *  3. The reset refuses any database whose name is not booking_test or booking_e2e,
 *     which is the check that still holds if the first two are subverted.
 *
 * And a fourth thing that is not a defence but a courtesy: a warning line at
 * bootstrap, so nobody has to read configuration to notice.
 */
@Module({
  imports: [BookingModule],
  controllers: [TestSupportController],
  providers: [TestSupportService],
})
export class TestSupportModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('TestSupport');

  onApplicationBootstrap(): void {
    this.logger.warn(
      '/api/test-support is mounted (ENABLE_TEST_SUPPORT=true). It can truncate the ' +
        'database and mark payments received. Never enable it outside a test environment.',
    );
  }
}

/**
 * What AppModule adds to its imports for this.
 *
 * A function rather than a ternary inline, so the rule has a name and a test. The
 * empty array is the whole point of the design: the module is not registered and
 * then disabled, it is never registered.
 */
export function testSupportImports(config: AppConfig): [typeof TestSupportModule] | [] {
  return config.ENABLE_TEST_SUPPORT ? [TestSupportModule] : [];
}
