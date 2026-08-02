import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

/** Paths no package should ever lint. */
export const DEFAULT_IGNORES = [
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/.vite/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/*.d.ts',
];

/**
 * Files that legitimately read `process.env`: the one validated config module,
 * build/test tool configs (which run before the config module exists), the
 * Prisma seed script, and test harnesses.
 */
const PROCESS_ENV_ALLOWED = [
  '**/src/config/env.schema.ts',
  '**/*.config.ts',
  '**/*.config.js',
  '**/*.config.mjs',
  // The seed's entrypoint. It lives under `src` so `nest build` compiles it —
  // the e2e stack and a first deployment both run `node dist/seed.main.js` — and
  // it reads DATABASE_URL before any container exists to read it from.
  '**/src/seed.main.ts',
  '**/test/**',
  '**/e2e/**',
];

/**
 * Build the shared flat config for one package.
 *
 * Each package passes its own `tsconfigRootDir` so type-aware rules resolve
 * against that package's tsconfig rather than this config package's.
 *
 * @param {{ tsconfigRootDir?: string, vue?: boolean, ignores?: string[] }} [options]
 */
export function createEslintConfig(options = {}) {
  const { tsconfigRootDir = process.cwd(), vue = false, ignores = [] } = options;

  const typedFiles = ['**/*.{ts,tsx,mts,cts}', ...(vue ? ['**/*.vue'] : [])];

  return tseslint.config(
    { ignores: [...DEFAULT_IGNORES, ...ignores] },

    {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: vue ? { ...globals.browser } : { ...globals.node },
      },
    },

    js.configs.recommended,

    ...(vue ? pluginVue.configs['flat/recommended'] : []),

    ...(vue
      ? [
          {
            files: ['**/*.vue'],
            rules: {
              // Conflicts with `exactOptionalPropertyTypes`. The rule wants every optional prop
              // to carry a default, but declaring `undefined` as the default of an
              // already-optional prop is exactly what that compiler option rejects — and in a
              // TypeScript component the type is the contract, not a runtime prop validator.
              'vue/require-default-prop': 'off',
            },
          },
        ]
      : []),

    {
      files: typedFiles,
      extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: {
          // Every TypeScript file a package lints must be reachable from that
          // package's tsconfig "include" — tool configs included. There is
          // deliberately no allowDefaultProject escape hatch: a file outside
          // the project should be a loud error and a one-line tsconfig fix,
          // not silently linted without type information.
          projectService: true,
          tsconfigRootDir,
          ...(vue ? { parser: tseslint.parser, extraFileExtensions: ['.vue'] } : {}),
        },
      },
      plugins: { 'import-x': importX },
      rules: {
        // Promise correctness. A dropped promise in a booking or payment path
        // is a silently lost side effect, so both of these are errors.
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/return-await': ['error', 'always'],

        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],

        // TypeScript is the source of truth for module resolution, so the
        // plugin is here only for deterministic import ordering.
        'import-x/no-unresolved': 'off',
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],

        'no-restricted-syntax': [
          'error',
          {
            selector: 'MemberExpression[property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]',
            message: 'Raw unsafe SQL is banned. Use Prisma.sql tagged templates.',
          },
          // Money arithmetic belongs to the Money value object, which is the one
          // place rounding and currency rules are defined and tested. Both
          // selectors are needed: a bare identifier (`amountCents - fee`) and a
          // property access (`payment.amountCents - fee`) are different nodes.
          {
            selector: 'BinaryExpression[operator=/^[*/+-]$/] > Identifier[name=/Cents$/]',
            message: 'Do not do arithmetic on cents directly. Use the Money value object.',
          },
          {
            selector:
              'BinaryExpression[operator=/^[*/+-]$/] > MemberExpression[property.name=/Cents$/]',
            message: 'Do not do arithmetic on cents directly. Use the Money value object.',
          },
          // Reservation expiry, the free-cancellation window and the
          // minimum-notice rule are all comparisons against "now". Code that
          // reads the wall clock directly can only be tested by sleeping.
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: 'Inject Clock instead of reading the wall clock directly.',
          },
          {
            selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
            message: 'Inject Clock instead of reading the wall clock directly.',
          },
        ],
        'no-restricted-properties': [
          'error',
          {
            object: 'process',
            property: 'env',
            message:
              'Read configuration through the validated config module, never process.env directly.',
          },
        ],
      },
    },

    // Plain JavaScript (tool configs) gets no type-aware rules.
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
    },

    // Tool configs, seeds and test harnesses run in Node even in the web app.
    {
      files: ['**/*.config.{ts,js,mjs}', '**/prisma/**', '**/test/**', '**/e2e/**'],
      languageOptions: { globals: { ...globals.node } },
    },

    { files: PROCESS_ENV_ALLOWED, rules: { 'no-restricted-properties': 'off' } },

    {
      // Where these primitives are defined is the one place allowed to use what
      // they exist to replace: cent arithmetic in the Money directory, and
      // reading the wall clock in the time directory. Tests, fixtures, seeds and
      // tool configs are also exempt — they legitimately construct concrete
      // instants, and a fixture cannot inject a clock into itself.
      //
      // Note the cost of ESLint's model: no-restricted-syntax is one rule, so
      // exempting a file exempts every selector in it. The cent ban therefore
      // does not apply inside test files. Production code is where it matters.
      files: [
        '**/domain/money/**',
        '**/domain/time/**',
        '**/test/**',
        '**/e2e/**',
        '**/*.config.{ts,js,mjs}',
        '**/src/seed.main.ts',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },

    // The one restriction that has to survive the exemption above. A committed
    // `it.only` shrinks the suite to a single case and CI still reports green,
    // so the failure mode is a silent loss of coverage rather than a red build.
    // It is restated here instead of joining the main list because that list is
    // switched off for exactly the files this needs to cover.
    {
      files: ['**/*.spec.{ts,tsx}', '**/*.int.spec.ts', '**/test/**', '**/e2e/**'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            // `it.only`, `test.only`, `describe.only`, `suite.only`, `bench.only`.
            selector:
              "MemberExpression[object.name=/^(it|test|describe|suite|bench)$/][property.name='only']",
            message: 'Remove .only before committing: CI would run a green but nearly empty suite.',
          },
          {
            // The chained forms: `it.concurrent.only`, `test.describe.only`.
            selector:
              "MemberExpression[object.object.name=/^(it|test|describe)$/][property.name='only']",
            message: 'Remove .only before committing: CI would run a green but nearly empty suite.',
          },
        ],
      },
    },

    // Re-assert the Vue parser for SFCs.
    //
    // `strictTypeChecked` sets `parser: tseslint.parser` for every file it matches, which for a
    // `.vue` file means the TypeScript parser sees `<template>` and fails at the first tag. A
    // single-file component has to be parsed by `vue-eslint-parser`, which then hands the
    // `<script>` block to the TypeScript parser through `parserOptions.parser`. This block has
    // to come after the typed configs, or they overwrite it again.
    ...(vue
      ? [
          {
            files: ['**/*.vue'],
            languageOptions: {
              parser: vueParser,
              parserOptions: {
                parser: tseslint.parser,
                projectService: true,
                tsconfigRootDir,
                extraFileExtensions: ['.vue'],
              },
            },
          },
        ]
      : []),

    // Must stay last so formatting-related rules are switched off.
    eslintConfigPrettier,
  );
}

export default createEslintConfig();
