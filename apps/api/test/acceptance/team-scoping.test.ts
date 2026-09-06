import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createApp } from '../../src/app.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * WS-3 AC3 — a team narrows what you see; it does not become a second boundary.
 *
 * > **Given** two teams in one workspace
 * > **When** a user lists tasks or documents for team A
 * > **Then** team B's artefacts are absent, while workspace-level integrations
 * > remain available to both
 *
 * Both halves matter, and the second is the one a careless implementation gets
 * wrong in the expensive direction. Scoping artefacts by team is ordinary; also
 * scoping *integrations* by team would double the surface on which isolation
 * can go wrong while providing no security the workspace boundary does not
 * already provide. RLS keys on `workspace_id`. The team is a predicate.
 */
describe('WS-3 team scoping', () => {
  let db: IsolatedDatabase
  let client: TestClient

  interface TwoTeams {
    owner: SignedInUser
    workspaceId: string
    teamA: string
    teamB: string
    integrationId: string
  }

  async function twoTeams(): Promise<TwoTeams> {
    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Delivery')
    const teams = (await (await owner.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const created = (await (
      await owner.post(`/workspaces/${workspace.id}/teams`, { name: 'Platform' })
    ).json()) as { id: string }

    // Workspace-level, seeded directly: connecting an integration is INT-1's
    // OAuth journey, and this is about what a team may see of one.
    const [integration] = await db.admin.query<{ id: string }>(
      `INSERT INTO integrations (id, workspace_id, kind) VALUES ($1, $2, 'github') RETURNING id`,
      [ulid(), workspace.id],
    )

    return {
      owner,
      workspaceId: workspace.id,
      teamA: teams[0]!.id,
      teamB: created.id,
      integrationId: integration!.id,
    }
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)
  })

  it("WS-3 AC3: artefact queries are scoped by team while integrations remain workspace-wide", async () => {
    // Given two teams in one workspace, each with a task and a document
    const w = await twoTeams()

    for (const [team, title] of [
      [w.teamA, 'Split the invoice parser'],
      [w.teamB, 'Rotate the signing keys'],
    ] as const) {
      const task = await w.owner.post(`/workspaces/${w.workspaceId}/teams/${team}/tasks`, { title })
      expect(task.status, await task.clone().text()).toBe(201)

      const document = await w.owner.post(`/workspaces/${w.workspaceId}/teams/${team}/documents`, {
        type: 'prd',
        title,
      })
      expect(document.status, await document.clone().text()).toBe(201)
    }

    // When a user lists tasks and documents for team A
    const tasks = (await (
      await w.owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamA}/tasks`)
    ).json()) as Array<{ title: string }>
    const documentsResponse = await w.owner.get(
      `/workspaces/${w.workspaceId}/teams/${w.teamA}/documents`,
    )
    expect(documentsResponse.status, await documentsResponse.clone().text()).toBe(200)
    const documents = (await documentsResponse.json()) as Array<{ title: string; teamId: string }>

    // Then team B's artefacts are absent
    expect(tasks.map((t) => t.title)).toEqual(['Split the invoice parser'])
    expect(documents.map((d) => d.title)).toEqual(['Split the invoice parser'])
    expect(documents.every((d) => d.teamId === w.teamA)).toBe(true)

    // and the workspace's integration is available to both teams — the same
    // integration id links a repository under either one.
    for (const [team, fullName] of [
      [w.teamA, 'acme/widgets'],
      [w.teamB, 'acme/platform'],
    ] as const) {
      const linked = await w.owner.post(
        `/workspaces/${w.workspaceId}/teams/${team}/repositories`,
        { integrationId: w.integrationId, provider: 'github', fullName },
      )
      expect(linked.status, `team ${team} should reach the workspace integration`).toBe(201)
    }
  })

  it('WS-3 AC3: a team with no artefacts of its own sees an empty list, not the workspace’s', async () => {
    // Given a workspace whose work all sits in team A
    const w = await twoTeams()
    await w.owner.post(`/workspaces/${w.workspaceId}/teams/${w.teamA}/tasks`, {
      title: 'Split the invoice parser',
    })
    await w.owner.post(`/workspaces/${w.workspaceId}/teams/${w.teamA}/documents`, {
      type: 'prd',
      title: 'Invoice splitting',
    })

    // When the other team lists its own
    const tasks = (await (
      await w.owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamB}/tasks`)
    ).json()) as unknown[]
    const documents = (await (
      await w.owner.get(`/workspaces/${w.workspaceId}/teams/${w.teamB}/documents`)
    ).json()) as unknown[]

    // Then it sees nothing. A list that falls back to "everything in the
    // workspace" when a team is empty is the failure this criterion is about,
    // and it looks like a working feature until the second team exists.
    expect(tasks).toEqual([])
    expect(documents).toEqual([])
  })
})
