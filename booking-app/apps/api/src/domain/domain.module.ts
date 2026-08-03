import { Global, Module } from '@nestjs/common';

import { CLOCK, SystemClock } from './time/clock.js';

/**
 * Domain primitives that need to be injectable.
 *
 * Money, the availability engine and the interval helpers are pure functions and
 * are imported directly; only the clock is a dependency, because "now" is the one
 * input the domain cannot compute for itself.
 */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class DomainModule {}
