import { createEslintConfig } from '@shape-and-flow/booking-config/eslint';

export default [
  // Prisma's generator output is compiled but never hand-edited or reviewed.
  { ignores: ['src/generated/**', 'dist/**'] },

  ...createEslintConfig({ tsconfigRootDir: import.meta.dirname }),

  {
    files: ['**/*.ts'],
    rules: {
      // Incompatible with emitDecoratorMetadata, which NestJS DI depends on:
      // rewriting an injected class import to `import type` erases the
      // constructor metadata and the parameter silently resolves as Object.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  {
    // A NestJS module is a declaration carrier by design: the decorator is the
    // whole point and the class body is meant to be empty.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },

  {
    // The in-memory fakes implement async ports without doing any I/O, so they
    // have nothing to await. They must stay `async` rather than returning
    // Promise.resolve: a synchronous throw is observably different from a
    // rejected promise, and every caller awaits them.
    files: ['**/fake-*.provider.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
];
