import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { join } from 'node:path'
import { z } from 'zod'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid, WorkflowDefinitionSchema, type AnyTool } from '@chorus/core'
import { createFakeModelProvider, type FakeModelProvider } from '@chorus/testing'
import { loadPromptDirectory } from '@chorus/llm'
import { createExecutor, type Executor } from '../../src/executor.js'
import { createRouter, type Router, type RoutingRule } from '../../src/router-service.js'
import { createToolRegistry } from '../../src/registry.js'

/**
 * AGENT-2 — routing, against a real database and a recording provider.
 *
 * Two properties only this layer can show. The first is AC1's, and it is the
 * one that pays for the whole rule table: **a rule match makes no model call**,
 * asserted by the fake provider recording zero requests rather than by reading
 * the code and believing it.
 *
 * The second is AC4's: the decision is the run's *first* event. A trace that
 * explains everything except how the run came to be this workflow answers the
 * wrong question — "why did it do that" starts with "why is it this at all".
 */
describe('AGENT-2 workflow router', () => {
  let db: IsolatedDatabase
  let models: FakeModelProvider
  let router: Router
  let executor: Executor

  const catalogue = ['shape-idea', 'implement-task', 'research', 'triage-feedback']

  const prompts = loadPromptDirectory(
    join(import.meta.dirname, '..', '..', '..', '..', 'workflows', 'prompts'),
  )

  /** Routing costs money, so a trigger names the workspace it is spent against. */
  const ROUTING_WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const ROUTING_TEAM = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

  const rules: RoutingRule[] = [
    {
      id: 'agent-tagged-task',
      workflow: 'implement-task',
      when: (t) => t.taskTag === 'agent',
      because: 'A task tagged for the agent is always an implementation request.',
    },
    { id: 'shape-command', workflow: 'shape-idea', when: (t) => t.slashCommand === 'shape' },
  ]

  const noop = (name: string): AnyTool =>
    ({
      name,
      description: name,
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      sideEffect: 'none',
      requiredRole: 'member',
      requiredScopes: [],
      execute: async () => ({ ran: name }),
    }) as unknown as AnyTool

  async function workspace(): Promise<{ workspaceId: string; userId: string; teamId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const [member] = await db.admin.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    )
    const [team] = await db.admin.query<{ id: string }>(
      `SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    )
    await db.admin.execute(`DELETE FROM run_events WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM run_steps WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM runs WHERE workspace_id = $1`, [workspaceId])
    return { workspaceId, userId: member!.user_id, teamId: team!.id }
  }

  const eventsFor = async (runId: string) =>
    db.admin.query<{ seq: number; kind: string; payload: Record<string, unknown> }>(
      `SELECT seq, kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [runId],
    )

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    models = createFakeModelProvider()
    router = createRouter({
      rules,
      workflows: catalogue,
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
      // The real file, not a fixture: a test against an invented prompt would
      // pass while the shipped one was malformed.
      prompts,
    })
    executor = createExecutor(db.config, {
      registry: createToolRegistry([noop('prepare')]),
      models,
      modelFor: () => ({ provider: 'fake', model: 'fake-1' }),
    })
  })

  it('AGENT-2 AC1: a rule match selects a workflow and asks no model anything', async () => {
    const decision = await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'please do this', taskTag: 'agent' })

    expect(decision).toMatchObject({
      kind: 'rule',
      workflow: 'implement-task',
      rule: 'agent-tagged-task',
    })
    // The assertion the AC names, and the reason the rule table exists: a
    // deterministic answer costs nothing and is explicable.
    expect(models.requests(), 'a rule match must make no model call').toHaveLength(0)
  })

  it('AGENT-2 AC5: an explicitly named workflow makes no model call either', async () => {
    const decision = await router.route({ kind: 'mcp', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, explicitWorkflow: 'research' })

    expect(decision).toMatchObject({ kind: 'explicit', workflow: 'research' })
    expect(models.requests()).toHaveLength(0)
  })

  it('AGENT-2 AC2: an unmatched trigger is classified, once', async () => {
    models.script({
      chunks: [
        JSON.stringify({
          candidates: [
            { workflow: 'shape-idea', confidence: 0.88 },
            { workflow: 'research', confidence: 0.2 },
          ],
          reasoning: 'An unformed idea rather than a defined task.',
        }),
      ],
    })

    const decision = await router.route({
      kind: 'chat',
      workspaceId: ROUTING_WORKSPACE,
      teamId: ROUTING_TEAM,
      text: 'I have a rough idea about onboarding',
    })

    expect(decision).toMatchObject({ kind: 'classified', workflow: 'shape-idea' })
    // Once, not once per candidate: classification is one question about one
    // trigger, and a loop here would multiply the cost of every unmatched turn.
    expect(models.requests()).toHaveLength(1)
  })

  it('AGENT-2 AC2: the classifier is only offered workflows that exist', async () => {
    models.script({
      chunks: [JSON.stringify({ candidates: [{ workflow: 'shape-idea', confidence: 0.9 }] })],
    })

    await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'something' })

    // A model asked to choose freely will invent a plausible name, and the run
    // would then fail at load on a workflow nobody wrote.
    const prompt = JSON.stringify(models.requests()[0])
    for (const workflow of catalogue) expect(prompt).toContain(workflow)
  })

  it('AGENT-2 AC2: a classifier naming a workflow that does not exist is discarded', async () => {
    models.script({
      chunks: [
        JSON.stringify({
          candidates: [
            { workflow: 'invent-a-workflow', confidence: 0.99 },
            { workflow: 'research', confidence: 0.8 },
          ],
        }),
      ],
    })

    const decision = await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'something' })

    // Trusting the name would start a run against a definition that does not
    // exist, and fail at the first step rather than here.
    expect(decision.kind === 'classified' && decision.workflow).toBe('research')
  })

  it('AGENT-2 AC3: low confidence asks rather than guessing', async () => {
    models.script({
      chunks: [
        JSON.stringify({
          candidates: [
            { workflow: 'shape-idea', confidence: 0.4 },
            { workflow: 'research', confidence: 0.35 },
          ],
        }),
      ],
    })

    const decision = await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'not sure what I want' })

    expect(decision.kind).toBe('ask')
    expect(decision.kind === 'ask' && decision.candidates.length).toBeGreaterThan(1)
  })

  it('AGENT-2 AC6: a classifier that returns nothing usable is unroutable, not a guess', async () => {
    models.script({ chunks: [JSON.stringify({ candidates: [] })] })

    const decision = await router.route({ kind: 'signal', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: '...' })

    expect(decision.kind).toBe('unroutable')
  })

  it('AGENT-2 AC6: a classifier that fails is unroutable rather than fatal', async () => {
    // A provider outage must not turn every unmatched trigger into a stack
    // trace. "I could not place this" is a usable answer; a 500 is not.
    models.script({ failWith: 'upstream unavailable' })

    const decision = await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'anything' })

    expect(decision.kind).toBe('unroutable')
  })

  it('AGENT-2 AC4: the decision is the run’s first event, with the rule and the trigger', async () => {
    const world = await workspace()
    const decision = await router.route({
      kind: 'chat',
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      entryPoint: 'web',
      taskTag: 'agent',
      text: 'go',
    })

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'implement-task',
        version: 1,
        tools: ['prepare'],
        steps: [{ id: 'prepare', type: 'tool', tool: 'prepare' }],
      }),
      input: {},
      routing: decision,
    })
    await executor.run(world.workspaceId, run.id)

    const events = await eventsFor(run.id)
    expect(events[0], 'routing must precede everything the run did').toMatchObject({
      seq: 1,
      kind: 'routing',
    })
    expect(events[0]!.payload).toMatchObject({
      decision: 'rule',
      workflow: 'implement-task',
      rule: 'agent-tagged-task',
      // Why the rule exists, not only that it fired.
      because: 'A task tagged for the agent is always an implementation request.',
      trigger: { kind: 'chat', entryPoint: 'web', taskTag: 'agent' },
    })
  })

  it('AGENT-2 AC4: a classified decision records its candidates and scores', async () => {
    const world = await workspace()
    models.script({
      chunks: [
        JSON.stringify({
          candidates: [
            { workflow: 'shape-idea', confidence: 0.93 },
            { workflow: 'research', confidence: 0.2 },
          ],
          reasoning: 'An unformed idea.',
        }),
      ],
    })
    const decision = await router.route({ kind: 'chat', workspaceId: ROUTING_WORKSPACE, teamId: ROUTING_TEAM, text: 'a rough idea' })

    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'shape-idea',
        version: 1,
        tools: ['prepare'],
        steps: [{ id: 'prepare', type: 'tool', tool: 'prepare' }],
      }),
      input: {},
      routing: decision,
    })

    const events = await eventsFor(run.id)
    // The losing candidates too. Recording only the winner makes systematic
    // misrouting invisible until somebody reproduces it by hand.
    expect(events[0]!.payload).toMatchObject({
      decision: 'classified',
      workflow: 'shape-idea',
      confidence: 0.93,
      reasoning: 'An unformed idea.',
    })
    expect((events[0]!.payload as { candidates: unknown[] }).candidates).toHaveLength(2)
  })

  it('AGENT-2 AC4: a run started without routing still records its own steps', async () => {
    // Routing is optional — a scheduled run of a named workflow has nothing to
    // decide — and its absence must not cost the rest of the trace.
    const world = await workspace()
    const run = await executor.start({
      workspaceId: world.workspaceId,
      teamId: world.teamId,
      startedBy: world.userId,
      definition: WorkflowDefinitionSchema.parse({
        name: 'implement-task',
        version: 1,
        tools: ['prepare'],
        steps: [{ id: 'prepare', type: 'tool', tool: 'prepare' }],
      }),
      input: {},
    })
    await executor.run(world.workspaceId, run.id)

    const events = await eventsFor(run.id)
    expect(events.some((event) => event.kind === 'tool_call')).toBe(true)
    expect(events.some((event) => event.kind === 'routing')).toBe(false)
  })
})
