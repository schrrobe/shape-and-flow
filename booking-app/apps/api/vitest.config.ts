import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    // Vitest's built-in transformer (Oxc since Vitest 4) does not emit
    // decorator metadata, so NestJS DI would resolve every constructor
    // parameter as Object inside tests. SWC does emit it.
    //
    // `oxc: false` is required, not optional: unplugin-swc only disables
    // `esbuild`, which Vite 7 no longer consults, so without this the built-in
    // transform still wins and SWC never runs. src/prisma/di-metadata.spec.ts
    // asserts the result rather than trusting this comment.
    oxc: false,
    plugins: [
      swc.vite({
        module: { type: 'es6' },
        jsc: {
          target: 'es2023',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
    test: {
      name: 'unit',
      environment: 'node',
      include: ['src/**/*.spec.ts'],
      setupFiles: ['./test/setup.unit.ts'],
    },
  }),
);
