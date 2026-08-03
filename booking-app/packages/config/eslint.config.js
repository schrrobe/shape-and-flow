import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import sonarjs from 'eslint-plugin-sonarjs';
import pluginVue from 'eslint-plugin-vue';
import pluginVueA11y from 'eslint-plugin-vuejs-accessibility';
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

/** Extensions import-x may append when following an import to a file. */
const TS_EXTENSIONS = ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'];
const TS_EXTENSIONS_WITH_VUE = [...TS_EXTENSIONS, '.vue'];

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

    ...(vue ? pluginVueA11y.configs['flat/recommended'] : []),

    ...(vue
      ? [
          {
            files: ['**/*.vue'],
            rules: {
              // `some` rather than the default `every`. The default demands that
              // a label both wrap its control and carry a `for`, which is
              // stricter than the accessibility it stands for: a `for` pointing
              // at the control's id is a complete association on its own, and so
              // is wrapping a checkbox in its own label. Left at the default,
              // the rule reports correct markup in the field components and in
              // the exports form, and a rule that cries wolf gets switched off.
              'vuejs-accessibility/label-has-for': [
                'error',
                { required: { some: ['nesting', 'id'] } },
              ],
            },
          },
        ]
      : []),

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
      plugins: { 'import-x': importX, sonarjs },
      settings: {
        // no-cycle has to follow imports to real files to mean anything, and it
        // fails silently in both directions if either half of that is missing.
        //
        // Resolution: this codebase writes ESM specifiers (`./interval.js`)
        // that point at TypeScript sources, which the plain Node resolver
        // cannot follow.
        //
        // Parsing: once a dependency is resolved it still has to be read, and
        // import-x parses dependencies with espree unless told otherwise. A
        // return type annotation is enough to make that throw, and an
        // unparseable dependency contributes no edges to the graph.
        //
        // Get either wrong and no-cycle reports nothing, which is
        // indistinguishable from a codebase that has no cycles.
        'import-x/resolver-next': [
          createTypeScriptImportResolver({
            project: `${tsconfigRootDir}/tsconfig.json`,
            alwaysTryTypes: true,
            ...(vue ? { extensions: TS_EXTENSIONS_WITH_VUE } : {}),
          }),
        ],
        'import-x/extensions': vue ? TS_EXTENSIONS_WITH_VUE : TS_EXTENSIONS,
        'import-x/parsers': {
          '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'],
          ...(vue ? { 'vue-eslint-parser': ['.vue'] } : {}),
        },
      },
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

        // TypeScript already reports unresolved imports, and it does it with
        // full knowledge of the project graph, so the plugin's own check would
        // only add a second opinion on the same question.
        'import-x/no-unresolved': 'off',

        // A cycle makes module initialisation order significant, which turns
        // an unrelated import reshuffle into an undefined at load time. Ten
        // levels is deep enough to catch the indirect ones that are hard to
        // see by reading; external packages are skipped because their cycles
        // are not ours to fix.
        'import-x/no-cycle': ['error', { maxDepth: 10, ignoreExternal: true }],
        'import-x/no-self-import': 'error',
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],

        // A subset, not the recommended set: most of the rest overlaps with
        // what strictTypeChecked already reports, and a second opinion on the
        // same line is noise rather than coverage.
        //
        // `sonarjs/cognitive-complexity` is deliberately absent. Six functions
        // are over a threshold of 12 — the availability engine at 30, the web
        // API client at 35, the demo seed at 18, an authorization integration
        // test at 24, and two more at 15 and 14 — so it cannot be switched on
        // as an error without either refactoring them first or picking a
        // ceiling so high the rule never fires. Both of those are their own
        // piece of work, and neither belongs in the commit that installs the
        // plugin.
        'sonarjs/no-identical-functions': 'error',
        'sonarjs/no-duplicated-branches': 'error',
        'sonarjs/no-nested-conditional': 'error',

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
