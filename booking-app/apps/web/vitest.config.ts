import { fileURLToPath, URL } from 'node:url';

import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import vue from '@vitejs/plugin-vue';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    plugins: [vue()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
      name: 'web',
      environment: 'happy-dom',
      include: ['src/**/*.spec.ts'],
      setupFiles: ['./src/test/setup.ts'],
    },
  }),
);
