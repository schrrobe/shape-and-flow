import { Injectable } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

/**
 * Guards the test toolchain, not the application.
 *
 * NestJS resolves constructor parameters from `design:paramtypes`, which only
 * exists if the transformer emits decorator metadata. Vitest's default
 * transformer does not, so this package configures SWC to do it. If that
 * configuration ever stops taking effect, DI inside tests silently resolves
 * every parameter as Object and failures appear far away from the cause — so
 * assert it directly, here, cheaply.
 */
@Injectable()
class Dependency {
  readonly value = 'dependency';
}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

describe('decorator metadata', () => {
  it('is emitted for injected constructor parameters', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', Consumer) as unknown[] | undefined;

    expect(
      paramTypes,
      'no design:paramtypes — the transformer is not emitting metadata',
    ).toBeDefined();
    expect(paramTypes).toHaveLength(1);
    expect(paramTypes?.[0]).toBe(Dependency);
    expect(paramTypes?.[0]).not.toBe(Object);
  });
});
