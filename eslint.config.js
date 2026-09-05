import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.d.ts',
      // Indexer fixtures are miniature *other people's* repositories, indexed
      // as data. Linting them would hold code we do not control to our rules,
      // and one of them is deliberately shaped like a repository that would
      // fail them.
      'packages/indexer/test/fixtures/**',
      // Next's build output. Generated, minified, and not ours to hold to
      // anything — linting it produces a thousand findings about code nobody
      // wrote and hides the handful about code somebody did.
      '**/.next/**',
      'apps/web/next-env.d.ts',
      // Playwright artefacts: traces and reports from a failed run.
      'test-results/**',
      'playwright-report/**',
    ],
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
    files: [
      'website/**/*.mjs',
      'website/**/*.ts',
      'scripts/**/*.mjs',
      // A framework config file is read by the framework's own CLI, in Node,
      // before any bundle exists.
      'apps/*/next.config.mjs',
    ],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
)
