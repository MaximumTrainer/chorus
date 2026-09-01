import { defineConfig } from 'vitest/config'

/**
 * A one-file project for the transcript recorder.
 *
 * Kept out of vitest.workspace.ts deliberately: the recorder writes files and
 * is not a test, and putting it in a test project would make `pnpm verify`
 * regenerate site assets as a side effect of running the suite.
 */
export default defineConfig({
  test: {
    name: 'capture',
    include: ['website/capture/record.ts', 'website/capture/status.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
