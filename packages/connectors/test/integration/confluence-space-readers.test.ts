import { describe, it, expect } from 'vitest'
import { createConfluenceConnector } from '../../src/confluence/index.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'

/**
 * NFR-4 AC1 / AND1 — who may read a Confluence space.
 *
 * A page with no restriction of its own is scoped to its space
 * (`confluence:space:<id>`), so the people who may read it are the space's
 * readers: users and groups granted `read` on the space. Any other permission
 * (creating a page, say) is not reading. A principal of a kind that cannot be
 * resolved to people — a role — grants nobody here, and is counted so the gap
 * is visible rather than silent. Space permissions name groups by id, so group
 * members are also read by id. A space deleted upstream has no readers.
 */

const frozen = new Date('2026-11-14T12:00:00.000Z')

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

describe('NFR-4 Confluence space readers', () => {
  it('NFR-4 AC1: users and groups with read on the space are its readers, across every page', async () => {
    const readers = await connectorFor('confluence/space-readers.json').spaceReaders(
      '98304',
      context('confluence/space-readers.json'),
    )
    expect(readers).toEqual({
      accountIds: ['acc-ada', 'acc-bob'],
      groupIds: ['grp-eng-id'],
      // The role principal grants read but resolves to nobody here.
      unresolvedPrincipals: 1,
    })
  })

  it('NFR-4 AND1: a space deleted upstream has no readers', async () => {
    const readers = await connectorFor('confluence/space-missing.json').spaceReaders(
      '404404',
      context('confluence/space-missing.json'),
    )
    expect(readers).toEqual({ accountIds: [], groupIds: [], unresolvedPrincipals: 0 })
  })

  it('NFR-4 AC1: a group named by id is read by id, people only', async () => {
    const members = await connectorFor('confluence/group-members-by-id.json').groupMembersById(
      'grp-eng-id',
      context('confluence/group-members-by-id.json'),
    )
    expect(members).toEqual([{ accountId: 'acc-grace', displayName: 'Grace Hopper', email: 'grace@acme.test' }])
  })

  it('NFR-4: reading space permissions is part of what the connector asks consent for', () => {
    const { auth } = createConfluenceConnector()
    expect(auth.kind === 'oauth2' ? auth.scopes : []).toContain('read:space:confluence')
  })
})
