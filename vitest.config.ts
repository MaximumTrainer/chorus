import { defineConfig } from 'vitest/config'

/**
 * Coverage configuration for the workspace.
 *
 * Deliberately separate from `vitest.workspace.ts`, which defines *which* tests
 * run; this defines what is measured when they do.
 *
 * The thresholds are a **floor, not a target**. CLAUDE.md §7 names "adding
 * tests afterwards to reach a coverage number" as an anti-pattern, and it is
 * right: a number to hit produces tests that assert what the code does. What a
 * floor is good for is the opposite case — a change that adds a module nothing
 * exercises at all. That is worth catching, and it is all this is for.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      // The shipped source only. Tests, fixtures and generated output would
      // flatter the number without telling anybody anything.
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        'apps/api/src/walking-skeleton/**',
        'packages/testing/**',
        'packages/db/src/testing.ts',
        'packages/db/src/migrate.ts',
      ],
      /**
       * Measured, not guessed. On the full suite this repository sits at 89.5%
       * lines, 81.4% branches and 94.7% functions; the floors are a few points
       * under, so ordinary variation does not fail a build and a module nobody
       * exercises does.
       *
       * They must be measured over **every** project. The same commit reports
       * 50.7% lines without the acceptance project and 89.5% with it, because
       * most of `apps/api` is exercised through its public entry points — which
       * is what CLAUDE.md §2 asks for. A coverage gate run over a subset would
       * report half the truth and fail well-tested code.
       */
      thresholds: {
        lines: 85,
        statements: 85,
        branches: 78,
        functions: 90,
      },
    },
  },
})
