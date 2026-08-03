import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      projects: ['./vitest.config.ts', './vitest.integration.config.ts'],
    },
  }),
);
