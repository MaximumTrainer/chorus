import { describe, it, expect } from 'vitest'
import { assembleBrief, type BriefInputs } from './brief.js'

/**
 * CODE-2 — the two properties a database cannot demonstrate.
 *
 * Determinism and truncation are both invisible when they break. A brief whose
 * bytes shift between identical runs still reads correctly; a brief that
 * silently lost its acceptance criteria still reads like a brief. Neither
 * announces itself, and both are cheapest to pin down here, where the inputs
 * can be made pathological on purpose.
 */

function inputs(overrides: Partial<BriefInputs> = {}): BriefInputs {
  return {
    charter: 'We ship small changes and we write the test first.',
    repositoryFullName: 'acme/billing',
    baseBranch: 'main',
    conventions: {
      packageManager: 'pnpm',
      testCommand: 'pnpm run test',
      lintCommand: 'pnpm run lint',
      formatCommand: null,
      buildCommand: null,
      contributionGuide: null,
      agentInstructions: ['AGENTS.md'],
      monorepo: null,
    },
    documents: [
      {
        title: 'Billing rework',
        documentType: 'prd',
        sections: [{ key: 'Summary', body: 'Three responsibilities in one function.' }],
      },
    ],
    decisions: [{ at: '2026-09-01', text: 'Parsing and posting split first.' }],
    captures: [{ kind: 'screenshot', note: 'The failing invoice screen.' }],
    task: {
      key: 'CH-1',
      title: 'Split the invoice parser',
      description: 'parseInvoice does three jobs.',
      acceptanceCriteria: ['Parsing is separated', 'Posting is behind an interface'],
      tags: ['billing'],
    },
    pointers: [
      {
        path: 'src/billing/parse.ts',
        symbolName: 'parseInvoice',
        lineStart: 1,
        lineEnd: 40,
        commitSha: 'commit-1',
        source: 'generated',
        stale: false,
      },
    ],
    ...overrides,
  }
}

describe('CODE-2 brief assembly', () => {
  it('CODE-2 AC3: the same inputs produce byte-identical output and the same hash', () => {
    const first = assembleBrief(inputs())
    const second = assembleBrief(inputs())

    expect(second.markdown).toBe(first.markdown)
    expect(second.hash).toBe(first.hash)
  })

  it('CODE-2 AC3: a changed input changes the hash', () => {
    // The other half of determinism, and the one that makes it useful: a hash
    // that never moved would be stable and worthless.
    const before = assembleBrief(inputs())
    const after = assembleBrief(inputs({ task: { ...inputs().task, title: 'Something else' } }))

    expect(after.hash).not.toBe(before.hash)
  })

  it('CODE-2: the stable prefix comes before the volatile part', () => {
    // §9.3: caching is a prefix match, so the charter and the repository's
    // conventions — which change on the scale of months — must precede the task
    // and its pointers, which change on the scale of minutes. Reversed, nothing
    // before the task can ever be reused.
    const { markdown } = assembleBrief(inputs())

    expect(markdown.indexOf('## Team charter')).toBeLessThan(markdown.indexOf('## Task'))
    expect(markdown.indexOf('## Repository')).toBeLessThan(markdown.indexOf('## Task'))
    expect(markdown.indexOf('## Task')).toBeLessThan(markdown.indexOf('## Code pointers'))
  })

  it('CODE-2 AC4: oversized input drops the lowest-priority section first', () => {
    const huge = 'x'.repeat(5_000)
    const brief = assembleBrief(
      inputs({ captures: [{ kind: 'screenshot', note: huge }] }),
      { budgetChars: 3_000 },
    )

    expect(brief.json.omitted).toContain('captures')
    expect(brief.markdown).not.toContain(huge)
  })

  it('CODE-2 AC4: criteria and pointers survive any budget', () => {
    // The two things the agent is being asked to satisfy and the two places it
    // is being told to look. A brief that dropped either would still look
    // complete, and would send the agent to the wrong files to satisfy the
    // wrong requirement.
    const brief = assembleBrief(
      inputs({
        charter: 'y'.repeat(20_000),
        documents: [
          {
            title: 'Huge',
            documentType: 'prd',
            sections: [{ key: 'Body', body: 'z'.repeat(20_000) }],
          },
        ],
      }),
      { budgetChars: 1_500 },
    )

    expect(brief.markdown).toContain('Parsing is separated')
    expect(brief.markdown).toContain('src/billing/parse.ts')
    expect(brief.json.task.acceptanceCriteria).toHaveLength(2)
    expect(brief.json.pointers).toHaveLength(1)
  })

  it('CODE-2 AC4: what was omitted is stated in the brief itself', () => {
    // Disclosed rather than silent. An agent working from a brief that quietly
    // lost a section produces work that is wrong for a reason nobody reading
    // the output can see.
    const brief = assembleBrief(
      inputs({ captures: [{ kind: 'screenshot', note: 'x'.repeat(9_000) }] }),
      { budgetChars: 2_000 },
    )

    expect(brief.markdown).toContain('## Omitted')
    expect(brief.markdown).toContain('captures')
  })

  it('CODE-2 AC5: a stale pointer is marked as stale in the text the agent reads', () => {
    const brief = assembleBrief(
      inputs({
        pointers: [
          {
            path: 'src/billing/parse.ts',
            symbolName: null,
            lineStart: 1,
            lineEnd: 40,
            commitSha: null,
            source: 'generated',
            stale: true,
          },
        ],
      }),
    )

    // In the Markdown, not only in the JSON: the agent reads the prose, and a
    // flag it never sees is not a warning.
    expect(brief.markdown).toMatch(/stale/i)
  })

  it('CODE-2 AC6: absent conventions say so rather than being left out', () => {
    const brief = assembleBrief(
      inputs({
        conventions: {
          packageManager: null,
          testCommand: null,
          lintCommand: null,
          formatCommand: null,
          buildCommand: null,
          contributionGuide: null,
          agentInstructions: [],
          monorepo: null,
        },
      }),
    )

    // An empty section reads as "nothing detected"; a missing one reads as
    // "there is nothing to run", and an agent acts differently on each.
    expect(brief.markdown).toContain('None detected')
  })
})
