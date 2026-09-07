import { createFakeModelProvider, createFakeSandbox } from '@chorus/testing'
import {
  describeCodingAdapterContract,
  CONTRACT_SPEC,
  type AdapterHarness,
} from '../../src/testing/adapter-kit.js'
import { createReferenceAdapter } from '../../src/adapters/reference.js'

/**
 * CODE-3 AC1/AC2 — the kit, run against the reference adapter.
 *
 * The kit is the deliverable here, not this file. The reference adapter is what
 * keeps it honest before a vendor CLI arrives: it is scriptable, so the kit can
 * demand behaviours a real coding agent will not produce on request — a hang, a
 * crash, an edit to a path it may not touch.
 *
 * It is also the adapter that proves the platform works with no third-party
 * tool installed (AC2), which is why it is built first rather than last.
 */

const MODEL = { provider: 'fake', model: 'fake-code-1' }

function adapterWith(script: Parameters<ReturnType<typeof createFakeModelProvider>['script']>[0]) {
  const models = createFakeModelProvider()
  models.script(script)
  return createReferenceAdapter({ models, model: MODEL })
}

const harness: AdapterHarness = {
  working: () => ({
    // No tool calls: the agent reads the brief, decides it is done, and
    // explains itself. The kit asserts the loop terminates and reports.
    adapter: adapterWith({ chunks: ['Split parseInvoice into parse and post.'] }),
    sandbox: createFakeSandbox(CONTRACT_SPEC, {
      change: {
        changedPaths: ['src/billing/parse.ts', 'test/billing/parse.test.ts'],
        addedLines: 120,
        removedLines: 40,
      },
      diff: '--- a/src/billing/parse.ts\n+++ b/src/billing/parse.ts\n',
      output: { pnpm: [{ type: 'stdout', text: 'all tests passed' }, { type: 'exit', code: 0 }] },
    }),
  }),

  hanging: () => ({
    // The model asks to run something, and the sandbox never returns from it.
    adapter: adapterWith({
      chunks: ['Running the tests first.'],
      toolCalls: [{ id: 'call_1', name: 'run', arguments: { command: 'pnpm run test' } }],
    }),
    sandbox: createFakeSandbox(CONTRACT_SPEC, { hang: true }),
  }),

  failing: () => ({
    adapter: adapterWith({ failWith: 'the model endpoint refused the connection' }),
    sandbox: createFakeSandbox(CONTRACT_SPEC, {
      change: { changedPaths: [], addedLines: 0, removedLines: 0 },
      output: { pnpm: [{ type: 'exit', code: 1 }] },
    }),
  }),

  outOfBounds: () => ({
    adapter: adapterWith({ chunks: ['Adjusted the workflow.'] }),
    sandbox: createFakeSandbox(CONTRACT_SPEC, {
      // A path the repository protects. The adapter is not asked to police
      // this; the sandbox's validation is, and the kit asserts the result is
      // refused whatever the adapter thinks of it.
      change: {
        changedPaths: ['.github/workflows/ci.yml'],
        addedLines: 4,
        removedLines: 1,
      },
      output: { pnpm: [{ type: 'exit', code: 0 }] },
    }),
  }),
}

describeCodingAdapterContract('reference', harness)
