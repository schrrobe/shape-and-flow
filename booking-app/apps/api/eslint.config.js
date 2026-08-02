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

  {
    // The availability engine, the pricing rules and the money and time
    // primitives are the part of this app worth testing without a database, a
    // queue or a Nest container. That only stays true if nothing pulls
    // infrastructure back into it, and today nothing does: the domain reaches
    // outside itself for the shared error type and for Prisma enum types, and
    // for nothing else.
    //
    // Nest itself is deliberately not restricted. `@Injectable` on the Clock
    // and the module that publishes these providers are how the domain is
    // reachable at all, and a hand-rolled indirection to avoid one import of a
    // decorator would cost more than the boundary it buys.
    files: ['src/domain/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './src/domain',
              from: './src',
              except: ['./domain', './common/errors', './prisma'],
              message:
                'The domain is framework- and database-free. Depend on it from the feature module, not the other way round.',
            },
          ],
        },
      ],

      // Complements the zone above. `src/prisma` is on its allowed list because
      // the generated enums are the vocabulary the domain and the database
      // share, but a type is a compile-time fact and the client is a runtime
      // dependency. Only the first is allowed through.
      //
      // This app switches `consistent-type-imports` off for NestJS DI, so
      // nothing else here would notice a value import creeping back in.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/prisma/client.js'],
              allowTypeImports: true,
              message:
                'Import Prisma enums into the domain as types only. A value import puts the client in the domain at runtime.',
            },
          ],
        },
      ],
    },
  },
];
