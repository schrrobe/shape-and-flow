import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      name: 'contracts',
      environment: 'node',
      include: ['src/**/*.spec.ts'],
    },
  }),
);
