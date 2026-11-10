import { describe, it, expect } from 'vitest'
import { createJiraConnector } from '../../src/jira/index.js'
import { runSinkAction } from '../../src/sink-runner.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'
import type { HierarchyConfig } from '../../src/jira/hierarchy.js'

/**
 * INT-8 AC4 — the hierarchy scheme is detected at connect time and the push
 * obeys it.
 *
 * Detection reads the project's style and the instance's field list; the push
 * then links a story to its epic the way that project actually supports —
 * through the Epic Link field on a company-managed project, through `parent` on
 * a team-managed one — so the tree is built, not silently dropped.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(cassette: string, hierarchy?: HierarchyConfig): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'jira_access' },
    config: { siteUrl: 'https://acme.atlassian.net', projectKey: 'ACME', ...(hierarchy ? { hierarchy } : {}) },
    now: () => frozen,
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  }
}

describe('INT-8 Jira hierarchy (AC4)', () => {
  it('INT-8 AC4: a company-managed project is detected as an epic-link scheme', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/hierarchy-classic.json') })
    const scheme = await connector.detectHierarchy('ACME', context('jira/hierarchy-classic.json'))
    expect(scheme).toEqual({ scheme: 'epic_link', epicLinkFieldId: 'customfield_10014' })
  })

  it('INT-8 AC4: a team-managed project is detected as a parent scheme', async () => {
    const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/hierarchy-nextgen.json') })
    const scheme = await connector.detectHierarchy('ACME', context('jira/hierarchy-nextgen.json'))
    expect(scheme).toEqual({ scheme: 'parent' })
  })

  it('INT-8 AC4: pushing a story to a company-managed project sets the Epic Link field', async () => {
    const posted = await capturePush(
      { scheme: 'epic_link', epicLinkFieldId: 'customfield_10014' },
      { projectKey: 'ACME', issueType: 'Story', summary: 'Child', parentKey: 'ACME-1', parentIsEpic: true },
    )
    expect(posted.fields).toMatchObject({ customfield_10014: 'ACME-1' })
    expect(posted.fields).not.toHaveProperty('parent')
  })

  it('INT-8 AC4: pushing the same story to a team-managed project sets parent instead', async () => {
    const posted = await capturePush(
      { scheme: 'parent' },
      { projectKey: 'ACME', issueType: 'Story', summary: 'Child', parentKey: 'ACME-1', parentIsEpic: true },
    )
    expect(posted.fields).toMatchObject({ parent: { key: 'ACME-1' } })
    expect(posted.fields).not.toHaveProperty('customfield_10014')
  })
})

/** Runs create_issue against a capturing fetch and returns the POSTed issue body. */
async function capturePush(
  hierarchy: HierarchyConfig,
  input: Record<string, unknown>,
): Promise<{ fields: Record<string, unknown> }> {
  let captured: { fields: Record<string, unknown> } | undefined
  const capturing = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.includes('/search')) return new Response(JSON.stringify({ issues: [] }), { status: 200 })
    if ((init?.method ?? 'GET') === 'POST' && u.endsWith('/rest/api/3/issue')) {
      captured = JSON.parse(init!.body as string) as { fields: Record<string, unknown> }
      return new Response(JSON.stringify({ id: '1', key: 'ACME-9' }), { status: 201 })
    }
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch

  const connector = createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: capturing })
  await runSinkAction(connector.sink!.actions.create_issue!, input, 'idem-hier', {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'jira_access' },
    config: { siteUrl: 'https://acme.atlassian.net', hierarchy },
    now: () => frozen,
    fetch: capturing,
    saveCredentials: async () => {},
  })
  if (!captured) throw new Error('no issue was POSTed')
  return captured
}
