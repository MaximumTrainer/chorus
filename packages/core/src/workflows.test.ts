import { describe, it, expect } from 'vitest'
import {
  WorkflowDefinitionSchema,
  validateDefinition,
  type WorkflowDefinition,
} from './workflows.js'

/**
 * AGENT-1 AC1 — definitions are validated at load.
 *
 * > it fails at startup with a message naming the workflow and the problem —
 * > **never at run time**.
 *
 * That emphasis is the requirement. A workflow that fails halfway because step
 * four references a tool that does not exist has already run steps one to
 * three, and some of those may have written something. Every check here is one
 * that would otherwise be discovered by a user, mid-run, after side effects.
 */

const environment = {
  tools: ['retrieve', 'search_code', 'find_duplicates'],
  prompts: ['decompose-tasks/propose.md'],
  schemas: ['TaskTree'],
}

const definition = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse({
    name: 'decompose-tasks',
    version: 3,
    tools: ['retrieve', 'find_duplicates'],
    model: 'balanced',
    steps: [
      { id: 'gather', type: 'retrieve', query: 'the document' },
      { id: 'propose', type: 'model', prompt: 'decompose-tasks/propose.md', schema: 'TaskTree' },
      { id: 'dedupe', type: 'tool', tool: 'find_duplicates' },
      { id: 'gate', type: 'checkpoint', kind: 'before_create_artefacts' },
      { id: 'emit', type: 'emit', artefact: 'structure_proposal' },
    ],
    ...overrides,
  })

describe('AGENT-1 AC1 workflow definitions', () => {
  it('AGENT-1 AC1: a sound definition validates with no problems', () => {
    expect(validateDefinition(definition(), environment)).toEqual([])
  })

  it('AGENT-1 AC1: a step calling an unregistered tool is a load-time problem', () => {
    const broken = definition({
      tools: ['retrieve', 'invented_tool'],
      steps: [
        { id: 'gather', type: 'retrieve', query: 'x', kinds: [], expand: 0, limit: 10 },
        { id: 'call', type: 'tool', tool: 'invented_tool' },
      ],
    })

    const problems = validateDefinition(broken, environment)
    // Named, because a message that says only "invalid workflow" sends someone
    // reading YAML by eye.
    expect(problems.some((p) => p.message.includes('invented_tool'))).toBe(true)
    expect(problems[0]!.workflow).toBe('decompose-tasks@3')
  })

  it('AGENT-1 AC1: an unknown step type is refused by the schema', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        steps: [{ id: 'a', type: 'teleport' }],
      }),
    ).toThrow()
  })

  it('AGENT-1 AC1: a missing prompt file is a load-time problem', () => {
    const broken = definition({
      steps: [{ id: 'propose', type: 'model', prompt: 'nowhere/missing.md' }],
    })

    expect(
      validateDefinition(broken, environment).some((p) => p.message.includes('nowhere/missing.md')),
    ).toBe(true)
  })

  it('AGENT-5 AC1: a step may not call a tool the workflow did not allow-list', () => {
    // The allow-list is a ceiling, not a manifest. Catching this at load means
    // the run never starts; catching it at run time means it stops partway.
    const broken = definition({
      tools: ['retrieve'],
      steps: [
        { id: 'gather', type: 'retrieve', query: 'x', kinds: [], expand: 0, limit: 10 },
        { id: 'dedupe', type: 'tool', tool: 'search_code' },
      ],
    })

    expect(
      validateDefinition(broken, environment).some((p) => p.message.includes('allow-list')),
    ).toBe(true)
  })

  it('AGENT-1 AC1: a branch to a step that does not exist is caught', () => {
    const broken = definition({
      steps: [
        { id: 'gather', type: 'retrieve', query: 'x', kinds: [], expand: 0, limit: 10 },
        { id: 'pick', type: 'branch', when: '{{gather.output}}', then: ['nowhere'], otherwise: [] },
      ],
    })

    expect(validateDefinition(broken, environment).some((p) => p.message.includes('nowhere'))).toBe(
      true,
    )
  })

  it('AGENT-1 AC1: duplicate step ids are caught', () => {
    // Two steps with one id make `{{id.output}}` ambiguous, and make resumption
    // match the wrong step — which is the more dangerous of the two.
    const broken = definition({
      steps: [
        { id: 'gather', type: 'retrieve', query: 'a', kinds: [], expand: 0, limit: 10 },
        { id: 'gather', type: 'retrieve', query: 'b', kinds: [], expand: 0, limit: 10 },
      ],
    })

    expect(
      validateDefinition(broken, environment).some((p) => p.message.includes('more than once')),
    ).toBe(true)
  })

  it('AGENT-1 AC1: every problem is reported, not just the first', () => {
    // A workflow author fixing one name at a time with a restart between each
    // is the experience this exists to prevent.
    const broken = definition({
      tools: ['ghost_one'],
      steps: [
        { id: 'a', type: 'tool', tool: 'ghost_two' },
        { id: 'b', type: 'model', prompt: 'missing.md' },
      ],
    })

    expect(validateDefinition(broken, environment).length).toBeGreaterThanOrEqual(3)
  })

  it('AGENT-1 AC5: a definition names a tier, and cannot name a model', () => {
    // The boundary rule forbids model names in source; this forbids them in
    // definitions, which are data and would otherwise escape it.
    expect(definition().model).toBe('balanced')
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        model: 'some-vendor-model-v2',
        steps: [{ id: 'a', type: 'emit', artefact: 'y' }],
      }),
    ).toThrow()
  })

  it('AGENT-1: a workflow with no steps is refused', () => {
    // It would "succeed" instantly and produce nothing, which is worse than
    // failing because it looks like it worked.
    expect(() =>
      WorkflowDefinitionSchema.parse({ name: 'x', version: 1, steps: [] }),
    ).toThrow()
  })

  it('AGENT-1: retrieval expansion and loops are bounded by the schema', () => {
    // Graph expansion is exponential in the hop count, and a loop over a
    // collection a model produced has no natural end.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        steps: [{ id: 'a', type: 'retrieve', query: 'q', expand: 9 }],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        steps: [{ id: 'a', type: 'loop', over: '{{x}}', body: ['a'], maxIterations: 10_000 }],
      }),
    ).toThrow()
  })

  it('AGENT-1: an unknown checkpoint kind in the defaults is rejected, not ignored', () => {
    // A typo'd checkpoint name that is silently stripped is a gate that does
    // not gate — and it would look configured.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        checkpoints: { before_somethign_typoed: 'ask' },
        steps: [{ id: 'a', type: 'emit', artefact: 'y' }],
      }),
    ).toThrow()
  })

  it('AGENT-1: a checkpoint step must name a known kind', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        steps: [{ id: 'a', type: 'checkpoint', kind: 'before_something_invented' }],
      }),
    ).toThrow()
  })

  it('AGENT-1: names and step ids are constrained so references parse one way', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'Not Kebab',
        version: 1,
        steps: [{ id: 'a', type: 'emit', artefact: 'y' }],
      }),
    ).toThrow()

    expect(() =>
      WorkflowDefinitionSchema.parse({
        name: 'x',
        version: 1,
        steps: [{ id: 'has.dot', type: 'emit', artefact: 'y' }],
      }),
    ).toThrow()
  })
})
