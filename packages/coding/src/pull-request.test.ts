import { describe, it, expect } from 'vitest'
import { pullRequestBody, pullRequestTitle, type PullRequestFacts } from './pull-request.js'

/**
 * CODE-5 — the pull request body.
 *
 * > The pull request is where a human meets the agent's work, and its body is
 * > the entire briefing that reviewer gets. Criteria as a checklist means
 * > review has a definition of done rather than an impression.
 *
 * So these are not formatting tests. Each one is a thing a reviewer needs in
 * order to judge the change, and its absence is a reviewer approving on vibes.
 */

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    taskKey: 'CH-1',
    taskTitle: 'Split the invoice parser',
    taskUrl: 'https://chorus.test/tasks/CH-1',
    documentUrl: 'https://chorus.test/documents/doc-1',
    briefUrl: 'https://chorus.test/jobs/job-1/brief',
    acceptanceCriteria: [
      'Parsing is separated from validation',
      'Posting moves behind its own interface',
    ],
    summary: 'Extracted parse() and post(), leaving parseInvoice as a thin caller.',
    testOutput: '12 passed, 0 failed',
    lintOutput: 'no problems',
    adapter: 'reference',
    requestedBy: 'ada@example.com',
    ...overrides,
  }
}

describe('CODE-5 pull request body', () => {
  it('CODE-5 AC3: it links the task, the source document and the brief', () => {
    const body = pullRequestBody(facts())

    expect(body).toContain('https://chorus.test/tasks/CH-1')
    expect(body).toContain('https://chorus.test/documents/doc-1')
    expect(body).toContain('https://chorus.test/jobs/job-1/brief')
  })

  it('CODE-5 AC3: acceptance criteria render as an unchecked checklist', () => {
    const body = pullRequestBody(facts())

    // Unchecked, deliberately. The agent asserting its own work is done is
    // exactly the judgement the review exists to make, and a pre-ticked box is
    // an invitation to skip making it.
    expect(body).toContain('- [ ] Parsing is separated from validation')
    expect(body).toContain('- [ ] Posting moves behind its own interface')
    expect(body).not.toContain('- [x]')
  })

  it('CODE-5 AC3: the summary and the test and lint results are present', () => {
    const body = pullRequestBody(facts())

    expect(body).toContain('Extracted parse() and post()')
    expect(body).toContain('12 passed, 0 failed')
    expect(body).toContain('no problems')
  })

  it('CODE-5 AC3: a task with no criteria says so rather than showing an empty list', () => {
    // An empty checklist reads as "nothing to check". Saying there were none
    // tells the reviewer they are judging without a definition of done, which
    // is a different and more useful thing to know.
    const body = pullRequestBody(facts({ acceptanceCriteria: [] }))

    expect(body).toMatch(/no acceptance criteria/i)
    expect(body).not.toContain('- [ ]')
  })

  it('CODE-5 AC3: absent results are stated, not silently omitted', () => {
    // A missing test section reads as "tests passed and nobody mentioned it".
    // The reviewer has to know the difference between green and unrun.
    const body = pullRequestBody(facts({ testOutput: '', lintOutput: '' }))

    expect(body).toMatch(/did not run|not run/i)
  })

  it('CODE-5: it says which agent wrote this and who asked for it', () => {
    // A reviewer reads a machine-written diff differently from a colleague's,
    // and is entitled to know which they have in front of them.
    const body = pullRequestBody(facts())

    expect(body).toContain('reference')
    expect(body).toContain('ada@example.com')
  })

  it('CODE-5: a document that does not exist is omitted rather than linked to nothing', () => {
    const body = pullRequestBody(facts({ documentUrl: undefined }))

    // The section is absent, not present-and-empty. A "Source document:" label
    // with nothing after it reads as a broken link rather than as no document.
    expect(body).not.toContain('undefined')
    expect(body).not.toMatch(/source document/i)
  })

  it('CODE-5: the title names the task by key, so it is findable from the tracker', () => {
    expect(pullRequestTitle(facts())).toBe('CH-1: Split the invoice parser')
  })
})
