import { createEslintConfig } from '@shape-and-flow/booking-config/eslint';

export default [
  { ignores: ['dist/**'] },
  ...createEslintConfig({ tsconfigRootDir: import.meta.dirname }),
];
