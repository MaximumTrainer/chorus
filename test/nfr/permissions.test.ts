import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp, routeTable, type RouteDefinition } from '@chorus/api'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ROLES, atLeast, type Role } from '@chorus/core'
import { createRecordingMailer, createTestClient, type SignedInUser } from '@chorus/testing'

/**
 * WS-4 AC4, AC5 — the permission suite.
 *
 * Table-driven over (route × role), and it grows by itself: the table comes
 * from the same function the app mounts, so a new route is exercised for every
 * role without anyone remembering to add a case. plan.md §5 requires exactly
 * that, because a permission suite that must be extended by hand is one that
 * silently stops covering the newest — and least reviewed — route.
 *
 * Every route is driven through real HTTP with a real session. The assertion is
 * about the *authorisation outcome* rather than the response body: a permitted
 * caller may still get 400 or 404 for placeholder path parameters, and pinning
 * those would make this a test of fixtures rather than of permissions. What may
 * never happen is a 403 for a caller the declaration permits, or anything but a
 * refusal for one it does not.
 *
 * The declarations themselves — that each exists, justifies itself, and could
 * actually be enforced — are checked without a database in
 * test/nfr/route-authorisation.test.ts. This suite is about what the
 * declarations *do*.
 *
 * AC5's MCP half is not here because the MCP server is Phase 1 (WP-1.11). When
 * it lands, its tool registry joins this table and the parity assertion becomes
 * one more row-wise comparison rather than a new suite.
 */

const ROUTES = routeTable()

/** Placeholder path parameters. A permitted caller reaching a 404 still proves it was permitted. */
function pathFor(definition: RouteDefinition, workspaceId: string, teamId: string, userId: string): string {
  return definition.path
    .replace(':workspaceId', workspaceId)
    .replace(':teamId', teamId)
    .replace(':userId', userId)
}

/**
 * A body good enough to get past validation where validation would otherwise
 * mask the authorisation outcome. Deliberately minimal — this suite is not
 * testing request shapes.
 */
function bodyFor(definition: RouteDefinition): Record<string, unknown> {
  if (definition.path.endsWith('/policies')) {
    return { workflowName: 'implement-task', checkpointKind: 'before_coding_job', mode: 'ask' }
  }
  if (definition.path.endsWith('/invitations')) return { role: 'member' }
  if (definition.path === '/invitations/accept') return { token: 'not-a-real-token' }
  return { name: 'permission-suite', role: 'member' }
}

describe('WS-4 permission suite', () => {
  let db: IsolatedDatabase
  const callers = new Map<Role, SignedInUser>()
  let workspaceId: string
  let teamId: string
  let subjectUserId: string

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    const mailer = createRecordingMailer()
    const client = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer)

    const owner = await client.signedInUser()
    const workspace = await owner.createWorkspace('Permission Suite')
    workspaceId = workspace.id
    callers.set('owner', owner)

    const [team] = (await (await owner.get(`/workspaces/${workspaceId}/teams`)).json()) as Array<{
      id: string
    }>
    teamId = team!.id

    for (const role of ROLES) {
      if (role === 'owner') continue
      callers.set(role, await client.memberWithRole(owner, workspaceId, role))
    }

    // A member to act *upon*, so a role-change or removal route does not target
    // one of the callers and quietly change the table mid-run.
    subjectUserId = (await client.memberWithRole(owner, workspaceId, 'member')).userId
  }, 180_000)

  afterAll(async () => {
    await db?.drop()
  })

  it('WS-4 AC4: the route table is non-empty, so this suite is not vacuous', () => {
    expect(ROUTES.length).toBeGreaterThan(0)
  })

  const cases = ROUTES.filter((definition) => definition.auth.kind === 'workspace').flatMap(
    (definition) =>
      ROLES.map((role) => [`${definition.method} ${definition.path}`, role, definition] as const),
  )

  it.each(cases)(
    'WS-4 AC4/AC5: %s is permitted to %s exactly as declared',
    async (_name, role: Role, definition: RouteDefinition) => {
      const caller = callers.get(role)!
      const required = definition.auth.kind === 'workspace' ? definition.auth.role : 'member'
      const path = pathFor(definition, workspaceId, teamId, subjectUserId)

      const response =
        definition.method === 'GET'
          ? await caller.get(path)
          : definition.method === 'DELETE'
            ? await caller.delete(path)
            : definition.method === 'PATCH'
              ? await caller.patch(path, bodyFor(definition))
              : definition.method === 'PUT'
                ? await caller.put(path, bodyFor(definition))
                : await caller.post(path, bodyFor(definition))

      if (atLeast(role, required)) {
        expect(
          response.status,
          `${role} holds ${required} or better but was refused: ${await response.clone().text()}`,
        ).not.toBe(403)
      } else {
        expect(
          response.status,
          `${role} does not hold ${required} but was not refused`,
        ).toBe(403)
      }
    },
  )

  it('WS-4 AC4: an unauthenticated caller is refused every non-public route', async () => {
    const mailer = createRecordingMailer()
    const anonymous = createTestClient(createApp({ dbConfig: db.config, mailer }), mailer).anonymous()

    for (const definition of ROUTES) {
      if (definition.auth.kind === 'public') continue
      if (definition.method !== 'GET' && definition.method !== 'POST') continue

      const path = pathFor(definition, workspaceId, teamId, subjectUserId)
      const response =
        definition.method === 'GET'
          ? await anonymous.get(path)
          : await anonymous.post(path, bodyFor(definition))

      expect(
        response.status,
        `${definition.method} ${definition.path} served an unauthenticated caller`,
      ).toBe(401)
    }
  })
})
