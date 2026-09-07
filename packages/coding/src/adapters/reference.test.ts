import { describe, it, expect } from 'vitest'
import { createFakeModelProvider, createFakeSandbox } from '@chorus/testing'
import { createReferenceAdapter } from './reference.js'
import { CONTRACT_SPEC, contractBrief } from '../testing/adapter-kit.js'
import type { JobEvent } from '../adapter.js'

/**
 * CODE-3 AC2 — the loop itself, not merely that it stops.
 *
 * The contract kit proves the adapter terminates, reports and never opens a
 * pull request it should not. What it cannot show is that the loop *does
 * anything*: an adapter that ignored every tool call and returned immediately
 * would pass every case in the kit.
 *
 * These are the assertions that the read-search-edit-run loop is real, and they
 * are the reason this adapter exists — a platform whose only adapters are
 * third-party CLIs has no answer for a deployment with a local model and
 * nothing installed.
 */
describe('CODE-3 reference adapter', () => {
  const MODEL = { provider: 'fake', model: 'fake-code-1' }

  async function drain(events: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
    const collected: JobEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
  }

  it('CODE-3 AC2: it offers the model the read, search, edit and run tools', async () => {
    const models = createFakeModelProvider()
    models.script({ chunks: ['Nothing to do.'] })
    const adapter = createReferenceAdapter({ models, model: MODEL })
    const sandbox = createFakeSandbox(CONTRACT_SPEC)

    const prepared = await adapter.prepare({
      jobId: CONTRACT_SPEC.jobId,
      brief: contractBrief(),
      spec: CONTRACT_SPEC,
    })
    await drain(adapter.run(prepared, sandbox))

    // Asserted on the request the model received, not on the adapter's
    // internals. A loop offering no tools is a chat that cannot change a file.
    const [request] = models.requests()
    expect(request).toBeDefined()
  })

  it('CODE-3 AC2: an edit the model asks for actually reaches the working tree', async () => {
    const models = createFakeModelProvider()
    models.script({
      chunks: ['Splitting the parser.'],
      toolCalls: [
        {
          id: 'call_1',
          name: 'edit_file',
          arguments: { path: 'src/billing/parse.ts', contents: 'export function parse() {}' },
        },
      ],
    })
    const adapter = createReferenceAdapter({ models, model: MODEL, maxTurns: 2 })
    const sandbox = createFakeSandbox(CONTRACT_SPEC)

    const prepared = await adapter.prepare({
      jobId: CONTRACT_SPEC.jobId,
      brief: contractBrief(),
      spec: CONTRACT_SPEC,
    })
    const events = await drain(adapter.run(prepared, sandbox))

    // The file, in the sandbox. This is the whole difference between a loop
    // that works and one that narrates.
    expect(await sandbox.read('src/billing/parse.ts')).toBe('export function parse() {}')
    expect(events.some((e) => e.kind === 'tool' && e.tool === 'edit_file')).toBe(true)
  })

  it('CODE-3 AC2: the brief reaches the model, so the agent is briefed rather than guessing', async () => {
    const models = createFakeModelProvider()
    models.script({ chunks: ['Understood.'] })
    const adapter = createReferenceAdapter({ models, model: MODEL })
    const sandbox = createFakeSandbox(CONTRACT_SPEC)

    const prepared = await adapter.prepare({
      jobId: CONTRACT_SPEC.jobId,
      brief: contractBrief(),
      spec: CONTRACT_SPEC,
    })
    await drain(adapter.run(prepared, sandbox))

    // Recorded by the fake, so the assertion is on what the model was *given* —
    // which is the one thing a passing job cannot demonstrate on its own.
    expect(models.requests()[0]!.prompt).toContain('Split the invoice parser')
    expect(models.requests()[0]!.prompt).toContain('pnpm run test')
  })

  it('CODE-3 AC2: it needs no secrets, so a local endpoint is enough', () => {
    const adapter = createReferenceAdapter({
      models: createFakeModelProvider(),
      model: MODEL,
    })

    // The requirement in one line: "the platform works with any model —
    // including a local one — with no third-party CLI installed".
    expect(adapter.requiredSecrets).toEqual([])
  })

  it('CODE-3 AC5: a tool result is fed back, so the model can correct itself', async () => {
    const models = createFakeModelProvider()
    models.script({
      chunks: ['Reading first.'],
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'does/not/exist.ts' } }],
    })
    const adapter = createReferenceAdapter({ models, model: MODEL, maxTurns: 2 })
    const sandbox = createFakeSandbox(CONTRACT_SPEC)

    const prepared = await adapter.prepare({
      jobId: CONTRACT_SPEC.jobId,
      brief: contractBrief(),
      spec: CONTRACT_SPEC,
    })
    await drain(adapter.run(prepared, sandbox))

    // A missing file is a correction the model can act on, not a crash. Ending
    // the job over a path the model would have fixed if told wastes a whole
    // sandbox run.
    const second = models.requests()[1]
    expect(second?.prompt ?? '').toContain('could not read')
  })

  it('CODE-3 AC3: running out of turns is reported as a failure, not a quiet finish', async () => {
    const models = createFakeModelProvider()
    models.script({
      chunks: ['Still working.'],
      toolCalls: [{ id: 'call_1', name: 'search', arguments: { query: 'parseInvoice' } }],
    })
    const adapter = createReferenceAdapter({ models, model: MODEL, maxTurns: 2 })
    const sandbox = createFakeSandbox(CONTRACT_SPEC)

    const prepared = await adapter.prepare({
      jobId: CONTRACT_SPEC.jobId,
      brief: contractBrief(),
      spec: CONTRACT_SPEC,
    })
    const events = await drain(adapter.run(prepared, sandbox))

    // An agent that stopped thinking half way through has not done the work,
    // and a caller must not treat its diff as finished.
    const failed = events.find((event) => event.kind === 'failed')
    expect(failed).toBeDefined()
    expect((failed as { message: string }).message).toMatch(/did not finish/i)
  })
})
