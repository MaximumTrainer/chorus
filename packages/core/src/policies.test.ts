import { describe, it, expect } from 'vitest'
import {
  CHECKPOINT_KINDS,
  PLATFORM_DEFAULT_MODE,
  resolveCheckpointPolicy,
  type PolicyRule,
} from './policies.js'

/**
 * WS-3 AC5 — checkpoint policy resolution.
 *
 * The order is fixed by architecture.md §11.5:
 *
 *     team+workflow+kind → team+kind → workflow default → platform default
 *
 * This is the function that decides whether an autonomous step runs unattended,
 * so it is pure, lives here once, and is consumed by the API and the agent
 * runtime alike. Two implementations would eventually disagree, and a
 * disagreement here is a gate that silently stopped gating.
 */
describe('WS-3 checkpoint policy resolution', () => {
  const team = 'team-alpha'
  const workflow = 'implement-task'
  const kind = 'before_external_write'

  const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
    checkpointKind: kind,
    mode: 'auto',
    ...over,
  })

  it('WS-3 AC5: with nothing configured, the platform default gates rather than opens', () => {
    // The default must fail *closed*. A missing policy meaning "go ahead" would
    // make every unconfigured workspace autonomous by omission.
    expect(PLATFORM_DEFAULT_MODE).toBe('ask')
    expect(resolveCheckpointPolicy([], { teamId: team, workflowName: workflow, checkpointKind: kind }))
      .toEqual({ mode: 'ask', source: 'platform' })
  })

  it('WS-3 AC5: a workflow default applies to a team that has not overridden it', () => {
    const rules = [rule({ workflowName: workflow, mode: 'auto' })]
    expect(
      resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind }),
    ).toEqual({ mode: 'auto', source: 'workflow' })
  })

  it('WS-3 AC5: a team value wins over the workflow default', () => {
    const rules = [
      rule({ workflowName: workflow, mode: 'auto' }),
      rule({ teamId: team, mode: 'ask' }),
    ]
    expect(
      resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind }),
    ).toEqual({ mode: 'ask', source: 'team' })
  })

  it('WS-3 AC5: the most specific rule — team and workflow — wins over both', () => {
    const rules = [
      rule({ workflowName: workflow, mode: 'auto' }),
      rule({ teamId: team, mode: 'ask' }),
      rule({ teamId: team, workflowName: workflow, mode: 'never' }),
    ]
    expect(
      resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind }),
    ).toEqual({ mode: 'never', source: 'team+workflow' })
  })

  it('WS-3 AC5: the documented order holds as each tier is removed in turn', () => {
    // Asserting the order as a sequence, not four unrelated cases: this is the
    // property architecture.md §11.5 actually states.
    const tiers: Array<{ rule: PolicyRule; source: string; mode: string }> = [
      { rule: rule({ teamId: team, workflowName: workflow, mode: 'never' }), source: 'team+workflow', mode: 'never' },
      { rule: rule({ teamId: team, mode: 'ask' }), source: 'team', mode: 'ask' },
      { rule: rule({ workflowName: workflow, mode: 'auto' }), source: 'workflow', mode: 'auto' },
    ]

    for (let removed = 0; removed < tiers.length; removed += 1) {
      const remaining = tiers.slice(removed).map((tier) => tier.rule)
      expect(
        resolveCheckpointPolicy(remaining, {
          teamId: team,
          workflowName: workflow,
          checkpointKind: kind,
        }),
        `after removing the ${removed} most specific tiers`,
      ).toMatchObject({ mode: tiers[removed]!.mode, source: tiers[removed]!.source })
    }

    expect(resolveCheckpointPolicy([], { teamId: team, workflowName: workflow, checkpointKind: kind }))
      .toMatchObject({ source: 'platform' })
  })

  it("WS-3 AC5: a rule for another team or another workflow does not apply", () => {
    const rules = [
      rule({ teamId: 'team-beta', mode: 'never' }),
      rule({ workflowName: 'triage-feedback', mode: 'never' }),
    ]
    expect(
      resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind }),
    ).toEqual({ mode: 'ask', source: 'platform' })
  })

  it('WS-3 AC5: rules for another checkpoint kind do not leak across kinds', () => {
    const rules = [rule({ teamId: team, checkpointKind: 'before_coding_job', mode: 'never' })]
    expect(
      resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind }),
    ).toEqual({ mode: 'ask', source: 'platform' })
  })

  it('WS-3 AC5: with no workflow in the query, only team-wide and platform tiers can match', () => {
    // An ad-hoc agent turn belongs to no named workflow. A workflow-keyed rule
    // must not be applied to it by accident.
    const rules = [
      rule({ workflowName: workflow, mode: 'auto' }),
      rule({ teamId: team, mode: 'never' }),
    ]
    expect(resolveCheckpointPolicy(rules, { teamId: team, checkpointKind: kind })).toEqual({
      mode: 'never',
      source: 'team',
    })
    expect(
      resolveCheckpointPolicy([rule({ workflowName: workflow, mode: 'auto' })], {
        teamId: team,
        checkpointKind: kind,
      }),
    ).toEqual({ mode: 'ask', source: 'platform' })
  })

  it('WS-3 AC5: a spend threshold travels with the rule that won', () => {
    const rules = [
      rule({ checkpointKind: 'before_spend_over', workflowName: workflow, mode: 'ask', spendThresholdCents: 1000 }),
      rule({ checkpointKind: 'before_spend_over', teamId: team, mode: 'ask', spendThresholdCents: 250 }),
    ]
    expect(
      resolveCheckpointPolicy(rules, {
        teamId: team,
        workflowName: workflow,
        checkpointKind: 'before_spend_over',
      }),
    ).toEqual({ mode: 'ask', source: 'team', spendThresholdCents: 250 })
  })

  it('WS-3 AC5: every checkpoint kind resolves, so none is silently ungated', () => {
    for (const checkpointKind of CHECKPOINT_KINDS) {
      expect(
        resolveCheckpointPolicy([], { teamId: team, checkpointKind }),
        `${checkpointKind} must resolve to a mode`,
      ).toMatchObject({ mode: 'ask' })
    }
  })

  it('WS-3 AC5: the first matching rule of a tier wins, and resolution never mutates its input', () => {
    const rules: PolicyRule[] = [rule({ teamId: team, mode: 'ask' })]
    const snapshot = JSON.stringify(rules)
    resolveCheckpointPolicy(rules, { teamId: team, workflowName: workflow, checkpointKind: kind })
    expect(JSON.stringify(rules), 'resolution must be pure').toBe(snapshot)
  })
})
