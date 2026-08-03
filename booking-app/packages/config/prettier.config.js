/** @type {import('prettier').Config} */
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
  overrides: [
    {
      // Prose reflows badly at 100 columns in diffs; leave markdown alone.
      files: ['*.md'],
      options: { printWidth: 80, proseWrap: 'preserve' },
    },
  ],
};
