import { describe, expect, it } from 'vitest';

import { featureFlagClientConfigSchema } from './feature-flags.js';

describe('featureFlagClientConfigSchema', () => {
  const valid = {
    url: 'https://unleash.shapeandflow.de/api/frontend',
    clientKey: 'default:development.frontend-test-token',
    appName: 'shape-and-flow-booking-web',
    environment: 'development',
    deployment: 'stage',
  } as const;

  it('accepts the exact public browser configuration', () => {
    expect(featureFlagClientConfigSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unsupported environments, deployments, and app names', () => {
    expect(
      featureFlagClientConfigSchema.safeParse({ ...valid, environment: 'stage' }).success,
    ).toBe(false);
    expect(
      featureFlagClientConfigSchema.safeParse({ ...valid, deployment: 'preview' }).success,
    ).toBe(false);
    expect(
      featureFlagClientConfigSchema.safeParse({ ...valid, appName: 'another-app' }).success,
    ).toBe(false);
  });

  it('rejects malformed URLs, empty client keys, and excess fields', () => {
    expect(featureFlagClientConfigSchema.safeParse({ ...valid, url: 'not-a-url' }).success).toBe(
      false,
    );
    expect(featureFlagClientConfigSchema.safeParse({ ...valid, clientKey: '' }).success).toBe(
      false,
    );
    expect(
      featureFlagClientConfigSchema.safeParse({ ...valid, backendToken: 'must-not-be-public' })
        .success,
    ).toBe(false);
  });
});
