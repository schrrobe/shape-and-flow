import { createEslintConfig } from '@shape-and-flow/booking-config/eslint';

export default [
  // Prisma's generator output is compiled but never hand-edited or reviewed.
  ...createEslintConfig({
    tsconfigRootDir: import.meta.dirname,
    ignores: ['src/generated/**'],
  }),

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
];
