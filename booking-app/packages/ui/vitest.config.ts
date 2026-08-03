import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import vue from '@vitejs/plugin-vue';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [vue()],
    test: {
      name: 'ui',
      // happy-dom rather than jsdom: these tests mount components and assert attributes and
      // focus, all of which it implements, and it starts in a fraction of the time.
      environment: 'happy-dom',
      include: ['src/**/*.spec.ts'],
    },
  }),
);
