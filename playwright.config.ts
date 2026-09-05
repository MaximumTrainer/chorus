import { defineConfig, devices } from '@playwright/test'

/**
 * Browser journeys (CLAUDE.md §4).
 *
 * A separate runner from Vitest because these are a different kind of test:
 * two real browser contexts against a real stack, asserting what a person
 * sees. The API and the collaboration server are started in `globalSetup`
 * rather than here, because they have to share a database that does not exist
 * until setup creates it — and because the mailer has to be reachable from the
 * setup code that drives sign-up.
 */
export default defineConfig({
  testDir: './test/e2e',
  globalSetup: './test/e2e/harness.ts',
  // A journey is allowed 90 seconds (CLAUDE.md §4). Anything slower is not a
  // slow test, it is a product somebody is waiting on.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    // Kept only for a failure. A trace per passing run is gigabytes nobody
    // reads; a trace for the one that failed is the whole diagnosis.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @chorus/web dev --port 3100 --hostname 127.0.0.1',
    // Playwright starts this *before* global setup, so the addresses are fixed
    // rather than discovered: the web app has to be told where the API is
    // before the API exists, and find it there when the first request arrives.
    env: {
      CHORUS_API_URL: 'http://127.0.0.1:3200',
      CHORUS_COLLAB_URL: 'ws://127.0.0.1:3201',
    },
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
