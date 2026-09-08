import { describe, it, expect } from 'vitest'
import { evaluateLaunch, branchNameFor, type LaunchConditions } from './launch.js'

/**
 * CODE-1 — deciding whether a job may launch.
 *
 * > A coding job spends money, writes to a repository and opens a pull request
 * > that colleagues will review. Those consequences are why the authorisation
 * > gate is a distinct requirement rather than a line in the handler, and why
 * > the eligibility reasons must be legible rather than a generic refusal.
 *
 * The decision is a pure function so both the API route and the MCP tool reach
 * the same verdict by construction rather than by two handlers agreeing today.
 */

function conditions(overrides: Partial<LaunchConditions> = {}): LaunchConditions {
  return {
    role: 'senior_member',
    repositoryLinked: true,
    adapter: 'reference',
    allowedAdapters: ['reference', 'claude-code'],
    activeJobId: undefined,
    taskKey: 'CH-1',
    taskTitle: 'Split the invoice parser',
    ...overrides,
  }
}

describe('CODE-1 launch eligibility', () => {
  it('CODE-1: a senior member with a linked repository may launch', () => {
    expect(evaluateLaunch(conditions())).toMatchObject({ allowed: true, reasons: [] })
  })

  it('CODE-1 AC1: a member is refused, and the reason names the role', () => {
    const verdict = evaluateLaunch(conditions({ role: 'member' }))

    expect(verdict.allowed).toBe(false)
    expect(verdict.reasons.join(' ')).toMatch(/senior_member/)
  })

  it('CODE-1 AC1: an admin and an owner may launch', () => {
    // Above the bar, not merely equal to it. A check written as equality would
    // refuse the two roles most likely to be doing it.
    expect(evaluateLaunch(conditions({ role: 'admin' })).allowed).toBe(true)
    expect(evaluateLaunch(conditions({ role: 'owner' })).allowed).toBe(true)
  })

  it('CODE-1 AC2: a missing repository is named specifically', () => {
    const verdict = evaluateLaunch(conditions({ repositoryLinked: false }))

    expect(verdict.allowed).toBe(false)
    expect(verdict.reasons.join(' ')).toMatch(/repository/i)
  })

  it('CODE-1 AC2: a disallowed adapter is named, along with what is allowed', () => {
    const verdict = evaluateLaunch(
      conditions({ adapter: 'aider', allowedAdapters: ['reference'] }),
    )

    expect(verdict.allowed).toBe(false)
    // Naming what *is* permitted turns a refusal into an instruction. A message
    // saying only "not allowed" sends the reader to the settings screen to
    // guess.
    expect(verdict.reasons.join(' ')).toContain('aider')
    expect(verdict.reasons.join(' ')).toContain('reference')
  })

  it('CODE-1 AC2: every blocking reason is returned, not just the first', () => {
    // The implementation note, and it is a user-experience requirement rather
    // than a stylistic one: somebody who fixes one blocker and immediately
    // meets the next has been made to do the work twice.
    const verdict = evaluateLaunch(
      conditions({
        role: 'member',
        repositoryLinked: false,
        adapter: 'aider',
        allowedAdapters: ['reference'],
      }),
    )

    expect(verdict.allowed).toBe(false)
    expect(verdict.reasons).toHaveLength(3)
  })

  it('CODE-1 AC3: an existing active job blocks a second, and is named', () => {
    const verdict = evaluateLaunch(conditions({ activeJobId: 'job-1' }))

    expect(verdict.allowed).toBe(false)
    // The caller is shown the existing job rather than told to try later.
    expect(verdict.existingJobId).toBe('job-1')
  })
})

describe('CODE-5 branch naming', () => {
  it('CODE-5 AC1: the branch is chorus/<task-key>-<slug>', () => {
    expect(branchNameFor('CH-1', 'Split the invoice parser')).toBe(
      'chorus/CH-1-split-the-invoice-parser',
    )
  })

  it('CODE-5 AC1: a title that would produce an invalid ref is made git-safe', () => {
    // git rejects a ref with spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, a
    // trailing dot or a trailing slash. A title is free text somebody typed, so
    // every one of these arrives eventually.
    const branch = branchNameFor('CH-2', 'Fix: parse~invoice..totals?? [urgent] ')

    expect(branch).toMatch(/^chorus\/CH-2-[a-z0-9-]+$/)
    expect(branch).not.toMatch(/\.\.|[~^:?*[\]\\ ]/)
    expect(branch.endsWith('.')).toBe(false)
    expect(branch.endsWith('/')).toBe(false)
  })

  it('CODE-5 AC1: a very long title is truncated rather than producing an unusable ref', () => {
    const branch = branchNameFor('CH-3', 'x'.repeat(400))

    expect(branch.length).toBeLessThan(120)
    expect(branch.startsWith('chorus/CH-3-')).toBe(true)
  })

  it('CODE-5 AC1: a title with nothing usable in it still yields a valid branch', () => {
    // "???" slugs to nothing, and `chorus/CH-4-` is not a valid ref. The key
    // alone is, and it still identifies the task.
    const branch = branchNameFor('CH-4', '???')

    expect(branch).toBe('chorus/CH-4')
  })
})
