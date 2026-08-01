import { createConfig } from '@shape-and-flow/booking-config/eslint';

export default createConfig({
  tsconfigRootDir: import.meta.dirname,
  vue: true,
  ignores: ['dist/**'],
});
