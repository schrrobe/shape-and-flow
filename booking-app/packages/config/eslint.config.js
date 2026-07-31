import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
  '**/prisma/seed.ts',
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

    {
      files: typedFiles,
      extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: {
          // allowDefaultProject covers root-level tool configs that no
          // tsconfig "include" glob picks up.
          projectService: {
            allowDefaultProject: ['*.ts', '*.mts', '*.js', '*.mjs'],
          },
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

    // Must stay last so formatting-related rules are switched off.
    eslintConfigPrettier,
  );
}

export default createEslintConfig();
