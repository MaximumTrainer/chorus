import { defineWorkspace } from 'vitest/config'

/**
 * Test layers, per CLAUDE.md §4. The layer a test belongs to is decided by
 * where it lives, so `pnpm test --grep <REQ-ID>` and `pnpm test:nfr` mean the
 * same thing on every machine and in CI.
 *
 * The feature layers pass with no tests while they are still empty; the nfr
 * script deliberately omits that flag, so the cross-cutting suites of
 * plan.md §5 can never silently vanish.
 */
export default defineWorkspace([
  {
    // One module, no I/O. Co-located with the code it describes.
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    // Exactly one seam: route + database, worker + queue, connector + cassette.
    test: {
      name: 'integration',
      include: ['packages/*/test/integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
    },
  },
  {
    // A plugin interface, exercised from recorded cassettes.
    test: {
      name: 'contract',
      include: ['packages/*/test/contract/**/*.test.ts', 'apps/*/test/contract/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
    },
  },
  {
    // The product as a user or an agent sees it.
    test: {
      name: 'acceptance',
      include: ['apps/*/test/acceptance/**/*.test.ts', 'test/acceptance/**/*.test.ts'],
      environment: 'node',
      testTimeout: 120_000,
    },
  },
  {
    // Tenancy, permissions, redaction, sandbox security, bootstrap: the
    // cross-cutting guarantees of plan.md §5. Green on every pull request.
    test: {
      name: 'nfr',
      include: ['test/nfr/**/*.test.ts'],
      environment: 'node',
      testTimeout: 120_000,
    },
  },
])
