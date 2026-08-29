import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import drizzle from 'eslint-plugin-drizzle';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      '**/playwright-report/**',
      // k6 scripts run in k6's own runtime (`k6/http`, `__ENV`), not in Node.
      // Linting them as Node modules reports globals that genuinely exist.
      'load/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/**/*.ts'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
      'drizzle/enforce-update-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Must come last: it relaxes the rule the preceding block sets for every file.
    //
    // NestJS resolves constructor dependencies from `design:paramtypes`, which
    // `emitDecoratorMetadata` only emits for VALUE imports. Rewriting an injected
    // class to `import type` elides it and breaks DI at runtime — silently, because
    // it still typechecks. Verified: `eslint --fix` under this rule rewrote
    // ConfigService and Reflector and took the API suite from 15 passing to 3 suites
    // failing to construct. lint-staged runs --fix on every commit, so leaving this
    // on would corrupt the app on any commit touching an injected class.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
);
