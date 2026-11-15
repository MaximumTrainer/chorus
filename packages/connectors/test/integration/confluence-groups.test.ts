import { describe, it, expect } from 'vitest'
import { createConfluenceConnector } from '../../src/confluence/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'

/**
 * NFR-4 AC1 / AND1 — reading who is in a Confluence group.
 *
 * A page restricted to a group is captured onto its signal as
 * `confluence:group:<name>`. For the people in that group to see it, the
 * membership sync needs the group's members, which this reads. Every page is
 * walked; an app account (automation, a bot) is not a person and is left out;
 * an email the user has hidden comes back as null rather than an empty string
 * a matcher could mistake for a value; and a group deleted upstream has nobody
 * in it, so the sync revokes rather than failing.
 */

const frozen = new Date('2026-11-13T12:00:00.000Z')

function context(cassette: string): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'confluence_access' },
    config: { siteUrl: 'https://acme.atlassian.net' },
    now: () => frozen,
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  }
}

const connectorFor = (cassette: string) =>
  createConfluenceConnector({ apiUrl: 'https://confluence.test/api', fetch: cassettePlayer(cassette) })

describe('NFR-4 Confluence group members', () => {
  it('NFR-4 AC1: every page of a group is read, people only, with hidden emails as null', async () => {
    const connector = connectorFor('confluence/group-members.json')
    const members = await connector.groupMembers('finance', context('confluence/group-members.json'))

    expect(members).toEqual([
      { accountId: '5b10ac8d82e05b22cc7d4ef5', displayName: 'Ada Lovelace', email: 'ada@acme.test' },
      { accountId: '5b10a2844c20165700ede21g', displayName: 'Grace Hopper', email: null },
      { accountId: '5b109f2e9729b51b54dc274d', displayName: 'Alan Turing', email: 'alan@acme.test' },
    ])
  })

  it('NFR-4 AND1: a group deleted upstream has no members, so access is revoked rather than an error', async () => {
    const connector = connectorFor('confluence/group-missing.json')
    expect(await connector.groupMembers('disbanded', context('confluence/group-missing.json'))).toEqual([])
  })

  it('NFR-4: reading group membership is part of what the connector asks consent for', () => {
    const { auth } = createConfluenceConnector()
    expect(auth.kind).toBe('oauth2')
    expect(auth.kind === 'oauth2' ? auth.scopes : []).toContain('read:confluence-groups')
  })
})
