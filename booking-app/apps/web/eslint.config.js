import { createEslintConfig } from '@shape-and-flow/booking-config/eslint';

export default createEslintConfig({
  tsconfigRootDir: import.meta.dirname,
  vue: true,
  ignores: ['dist/**'],
});
