import { describe, expect, it } from 'vitest';

import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports process liveness without dependencies', () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});
