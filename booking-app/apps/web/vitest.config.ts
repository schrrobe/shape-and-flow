import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import vue from '@vitejs/plugin-vue';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [vue()],
    test: {
      name: 'web',
      environment: 'happy-dom',
      include: ['src/**/*.spec.ts'],
      setupFiles: ['./src/test/setup.ts'],
    },
  }),
);
