import { describe, expect, it } from 'vitest';

import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports process liveness without dependencies', () => {
    const controller = Reflect.construct(HealthController, []) as HealthController;

    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
