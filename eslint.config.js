import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md §7: a bare `any` used to bypass a type error is an anti-pattern.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // CLAUDE.md §10: never throw strings; never swallow.
      'no-throw-literal': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests read fixtures of unknown shape; the parsed-YAML boundary is untyped
    // by nature, so `any` there is honest rather than a bypass.
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // The repository's own tooling — the website builder, its recorders, and the
    // documentation sync — are command-line programs, not library code: writing
    // to stdout is their interface, and they run in Node rather than in a
    // bundle, so the Node globals are genuinely present.
    files: ['website/**/*.mjs', 'website/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
)
