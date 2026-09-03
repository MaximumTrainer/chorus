import { describe, it, expect } from 'vitest'
import { decideRoute, type RoutingRule, type Trigger } from './router.js'

/**
 * AGENT-2 — routing, decided.
 *
 * The requirement's shape is an ordering, and the order is the whole point:
 * explicit selection, then rules, then a classifier, then asking. Every step
 * down that list is slower, costlier and less explicable than the one above it,
 * so the tests here are mostly about *not* reaching the next step.
 *
 * `decideRoute` is pure and takes the classifier's answer as an argument rather
 * than calling one. That is not an accident of testing: it is what makes AC1 —
 * "no model call is made" — a property of the code's shape rather than
 * something to remember. A rule match returns before anything could have asked.
 */

const rules: RoutingRule[] = [
  { id: 'task-tag', workflow: 'implement-task', when: (t) => t.taskTag === 'agent' },
  { id: 'slash', workflow: 'shape-idea', when: (t) => t.slashCommand === 'shape' },
  { id: 'capture', workflow: 'triage-feedback', when: (t) => t.captureMode === 'feedback' },
  // Deliberately overlapping with the first, and deliberately later.
  { id: 'any-task', workflow: 'refine-task', when: (t) => t.taskTag !== undefined },
]

const chat = (overrides: Partial<Trigger> = {}): Trigger => ({
  kind: 'chat',
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  text: 'can you help with this',
  ...overrides,
})

describe('AGENT-2 routing', () => {
  it('AGENT-2 AC1: a matching rule wins, and nothing is asked of a model', () => {
    const decision = decideRoute({ trigger: chat({ taskTag: 'agent' }), rules })

    expect(decision).toMatchObject({ kind: 'rule', workflow: 'implement-task', rule: 'task-tag' })
    // The classifier is an argument. Reaching it would mean the caller had to
    // run one first, which is exactly what AC1 forbids on a rule match.
    expect('classification' in decision).toBe(false)
  })

  it('AGENT-2 AC1: rules are first-match, in the order they are written', () => {
    // `task-tag` and `any-task` both match. Order decides, and it must be the
    // written order rather than anything derived — a routing table whose
    // precedence depends on specificity scoring is one nobody can predict.
    const decision = decideRoute({ trigger: chat({ taskTag: 'agent' }), rules })
    expect(decision).toMatchObject({ rule: 'task-tag' })

    const other = decideRoute({ trigger: chat({ taskTag: 'anything-else' }), rules })
    expect(other).toMatchObject({ rule: 'any-task', workflow: 'refine-task' })
  })

  it('AGENT-2 AC5: an explicitly named workflow bypasses rules entirely', () => {
    // A slash command naming a workflow, or an MCP call. Running a rule over it
    // would let the table quietly override what the caller asked for.
    const decision = decideRoute({
      trigger: chat({ taskTag: 'agent', explicitWorkflow: 'draft-document' }),
      rules,
    })

    expect(decision).toMatchObject({ kind: 'explicit', workflow: 'draft-document' })
  })

  it('AGENT-2 AC2: an unmatched trigger uses the classification it was given', () => {
    const decision = decideRoute({
      trigger: chat(),
      rules,
      classification: {
        candidates: [
          { workflow: 'shape-idea', confidence: 0.82 },
          { workflow: 'research', confidence: 0.11 },
        ],
        reasoning: 'The user describes an unformed idea rather than a defined task.',
      },
    })

    expect(decision).toMatchObject({
      kind: 'classified',
      workflow: 'shape-idea',
      confidence: 0.82,
    })
  })

  it('AGENT-2 AC2: the full candidate list is carried, not just the winner', () => {
    // "It is the only way to diagnose systematic misrouting later." A decision
    // that records only its answer cannot be reviewed, only re-run.
    const decision = decideRoute({
      trigger: chat(),
      rules,
      classification: {
        candidates: [
          { workflow: 'shape-idea', confidence: 0.91 },
          { workflow: 'research', confidence: 0.31 },
          { workflow: 'draft-document', confidence: 0.04 },
        ],
      },
    })

    expect(decision.kind).toBe('classified')
    expect(decision.kind === 'classified' && decision.candidates).toHaveLength(3)
  })

  it('AGENT-2 AC3: below the threshold it asks, and offers the candidates it was choosing between', () => {
    const decision = decideRoute({
      trigger: chat(),
      rules,
      threshold: 0.7,
      classification: {
        candidates: [
          { workflow: 'shape-idea', confidence: 0.44 },
          { workflow: 'research', confidence: 0.41 },
          { workflow: 'draft-document', confidence: 0.05 },
        ],
      },
    })

    expect(decision.kind).toBe('ask')
    // The two it was actually torn between. Offering all of them, including one
    // scored 0.05, would make the question harder to answer than the original
    // request was to make.
    expect(decision.kind === 'ask' && decision.candidates.map((c) => c.workflow)).toEqual([
      'shape-idea',
      'research',
    ])
  })

  it('AGENT-2 AC3: a near-tie asks even when the top score clears the threshold', () => {
    // 0.72 and 0.71 is not confidence, it is a coin toss that happens to be
    // above a line. Guessing here is how a user learns not to trust the agent
    // with anything ambiguous.
    const decision = decideRoute({
      trigger: chat(),
      rules,
      threshold: 0.7,
      classification: {
        candidates: [
          { workflow: 'shape-idea', confidence: 0.72 },
          { workflow: 'research', confidence: 0.71 },
        ],
      },
    })

    expect(decision.kind).toBe('ask')
  })

  it('AGENT-2 AC6: an unroutable trigger says so rather than picking something', () => {
    const decision = decideRoute({
      trigger: chat(),
      rules,
      classification: { candidates: [] },
    })

    expect(decision.kind).toBe('unroutable')
    // User-facing, and specific enough to act on. "Routing failed" tells the
    // person nothing they can do differently, so the message has to name what
    // would place it — an explicit workflow, or a rule.
    const reason = decision.kind === 'unroutable' ? decision.reason : ''
    expect(reason).toMatch(/workflow/i)
    expect(reason).toMatch(/rule/i)
  })

  it('AGENT-2 AC6: no rules and no classifier is unroutable, not a default', () => {
    // Defaulting to the first registered workflow would be the worst kind of
    // bug: plausible-looking output from a request nobody understood.
    const decision = decideRoute({ trigger: chat(), rules: [] })

    expect(decision.kind).toBe('unroutable')
  })

  it('AGENT-2 AC4: every decision carries the trigger that produced it', () => {
    // AC4 asks the trace to name the trigger. Carrying it on the decision means
    // the logger cannot record one without the other.
    for (const decision of [
      decideRoute({ trigger: chat({ taskTag: 'agent' }), rules }),
      decideRoute({ trigger: chat({ explicitWorkflow: 'x' }), rules }),
      decideRoute({ trigger: chat(), rules, classification: { candidates: [] } }),
    ]) {
      expect(decision.trigger.kind).toBe('chat')
    }
  })

  it('AGENT-2: a rule that throws does not take the whole router down with it', () => {
    // Rules are data written by whoever adds an integration, and one of them
    // will eventually read a field that is not there. Falling through to the
    // classifier is a worse answer than the rule would have given, and a far
    // better one than every trigger failing.
    const broken: RoutingRule[] = [
      {
        id: 'explodes',
        workflow: 'never',
        when: () => {
          throw new Error('undefined is not an object')
        },
      },
      { id: 'fallback', workflow: 'shape-idea', when: () => true },
    ]

    expect(decideRoute({ trigger: chat(), rules: broken })).toMatchObject({
      kind: 'rule',
      rule: 'fallback',
    })
  })
})
