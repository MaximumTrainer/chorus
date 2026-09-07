import { describe, it, expect } from 'vitest'
import { createFakeSandbox } from '@chorus/testing'
import {
  describeCodingAdapterContract,
  CONTRACT_SPEC,
  contractBrief,
  type AdapterHarness,
} from '../../src/testing/adapter-kit.js'
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js'

/**
 * CODE-3 AC1 — the same kit, a second adapter.
 *
 * Byte-identical to the suite the reference adapter passes, with no
 * adapter-specific exemption. That is the assertion: a kit with an exemption is
 * not a contract, it is a description of whichever adapter was written first,
 * and the promise an adapter-pluggable platform makes is that swapping one for
 * another does not change what a job means.
 *
 * The spec below carries the one secret this adapter declares. The runner
 * builds the real environment from that declaration (CODE-4 AC1), so an adapter
 * that quietly read a second variable would find it absent here rather than
 * present in production.
 */

const SPEC = { ...CONTRACT_SPEC, secrets: { ANTHROPIC_API_KEY: 'sk-ant-adapter' } }

const harness: AdapterHarness = {
  working: () => ({
    adapter: createClaudeCodeAdapter(),
    sandbox: createFakeSandbox(SPEC, {
      change: {
        changedPaths: ['src/billing/parse.ts', 'test/billing/parse.test.ts'],
        addedLines: 120,
        removedLines: 40,
      },
      diff: '--- a/src/billing/parse.ts\n+++ b/src/billing/parse.ts\n',
      output: {
        claude: [{ type: 'stdout', text: 'Split parseInvoice.' }, { type: 'exit', code: 0 }],
        pnpm: [{ type: 'stdout', text: 'all tests passed' }, { type: 'exit', code: 0 }],
      },
    }),
  }),

  hanging: () => ({
    adapter: createClaudeCodeAdapter(),
    sandbox: createFakeSandbox(SPEC, { hang: true }),
  }),

  failing: () => ({
    adapter: createClaudeCodeAdapter(),
    sandbox: createFakeSandbox(SPEC, {
      change: { changedPaths: [], addedLines: 0, removedLines: 0 },
      output: {
        claude: [{ type: 'stderr', text: 'authentication failed' }, { type: 'exit', code: 1 }],
        pnpm: [{ type: 'exit', code: 1 }],
      },
    }),
  }),

  outOfBounds: () => ({
    adapter: createClaudeCodeAdapter(),
    sandbox: createFakeSandbox(SPEC, {
      change: { changedPaths: ['.github/workflows/ci.yml'], addedLines: 4, removedLines: 1 },
      output: {
        claude: [{ type: 'exit', code: 0 }],
        pnpm: [{ type: 'exit', code: 0 }],
      },
    }),
  }),
}

describeCodingAdapterContract('claude-code', harness)

/**
 * The properties that are specific to this adapter, and are the reason it is a
 * thin wrapper rather than a second agent loop.
 */
describe('CODE-3 claude-code adapter', () => {
  it('CODE-3 AC4: it declares exactly one secret', () => {
    // The sandbox environment is an allow-list built from this declaration. A
    // second key here would be a credential nobody granted the adapter.
    expect(createClaudeCodeAdapter().requiredSecrets).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('CODE-3 AC3: the entrypoint cannot stop to ask a question', async () => {
    const prepared = await createClaudeCodeAdapter().prepare({
      jobId: SPEC.jobId,
      brief: contractBrief(),
      spec: SPEC,
    })
    const command = prepared.command.join(' ')

    // `--print` runs headlessly and exits. The permission mode is the part that
    // matters most: in a container with no terminal, a prompt for confirmation
    // is a hang that lasts until the wall-clock limit and reports nothing.
    expect(command).toContain('--print')
    expect(command).toContain('--permission-mode')
  })

  it('CODE-3: it passes the brief through unchanged rather than rewriting it', async () => {
    const brief = contractBrief()
    const prepared = await createClaudeCodeAdapter().prepare({
      jobId: SPEC.jobId,
      brief,
      spec: SPEC,
    })

    // Byte-identical. An adapter that reworded the brief would be a second
    // brief builder, and CODE-2 AC2 rests on there being exactly one.
    expect(prepared.files['BRIEF.md']).toBe(brief.markdown)
  })

  it('CODE-3 AC5: a stream that ends with no exit code is a failure, not a success', async () => {
    // The runtime lost the process. A job whose outcome is unknown must not
    // become a pull request, and "no events" is the shape that most easily
    // reads as "nothing went wrong".
    const adapter = createClaudeCodeAdapter()
    const sandbox = createFakeSandbox(SPEC, { output: { claude: [] } })
    const prepared = await adapter.prepare({ jobId: SPEC.jobId, brief: contractBrief(), spec: SPEC })

    const events = []
    for await (const event of adapter.run(prepared, sandbox)) events.push(event)

    expect(events.at(-1)?.kind).toBe('failed')
  })
})
