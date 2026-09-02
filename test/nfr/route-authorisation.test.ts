import { describe, it, expect } from 'vitest'
import { routeTable, type RouteDefinition } from '@chorus/api'

/**
 * WS-4 AC4 — every route declares the role and scope it requires.
 *
 * The point of making the requirement *declarative data* rather than a check
 * inside each handler is that it can be enumerated. A forgotten check is then
 * impossible: a route can only be wrong, never silently unguarded. This suite
 * is what turns that from an intention into a build failure.
 *
 * plan.md §5 requires this to grow automatically — every new route appears here
 * without anyone remembering to add it. That is why the table comes from the
 * same function the app mounts, rather than from the subset that happens to be
 * declared statically: a route the suite cannot see is precisely the silently
 * unguarded route the declaration was meant to make impossible.
 */
const ROUTES = routeTable()

describe('WS-4 AC4 route authorisation is declared, not remembered', () => {
  it('WS-4 AC4: the route table is non-empty, so this suite is not vacuous', () => {
    expect(ROUTES.length).toBeGreaterThan(0)
  })

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'WS-4 AC4: %s declares its authorisation',
    (_name, route: RouteDefinition) => {
      expect(route.auth, 'every route must declare an auth requirement').toBeDefined()

      if (route.auth.kind === 'public') {
        // Public routes must say why, so "public" is a decision rather than an
        // omission that nobody notices.
        expect(route.auth.reason, 'a public route must justify itself').toBeTruthy()
        expect(route.auth.reason.length).toBeGreaterThan(10)
      } else if (route.auth.kind === 'authenticated') {
        // Requiring a session but no membership is also a decision, and it is
        // the one most easily reached for by mistake — so it justifies itself
        // on the same terms as `public`.
        expect(route.auth.reason, 'a membership-free route must justify itself').toBeTruthy()
        expect(route.auth.reason.length).toBeGreaterThan(10)
        expect(Array.isArray(route.auth.scopes)).toBe(true)
      } else {
        expect(['member', 'senior_member', 'admin', 'owner']).toContain(route.auth.role)
        expect(Array.isArray(route.auth.scopes)).toBe(true)
      }
    },
  )

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'WS-4 AC4: %s can actually be enforced as declared',
    (_name, route: RouteDefinition) => {
      // Structural, not stylistic: the middleware resolves the caller's role
      // from `:workspaceId`. A route declaring a workspace role without that
      // parameter could never have that role resolved, and would be silently
      // unenforceable — the exact failure the declaration exists to prevent.
      if (route.auth.kind !== 'workspace') return
      expect(
        route.path.includes(':workspaceId'),
        `${route.method} ${route.path} requires a workspace role but names no workspace`,
      ).toBe(true)
    },
  )

  it('WS-4 AC4: a route requiring no membership is rare and deliberate', () => {
    // If this list grows, someone has reached for `authenticated` to dodge a
    // permission check rather than because no workspace is in scope.
    //
    // The two OAuth consent routes are here because choosing a workspace *is*
    // the consent step (WS-5 AC3): requiring membership before the person has
    // said which workspace they mean would be circular. What stops that being
    // a hole is that `approve` re-checks membership in the chosen workspace
    // before issuing anything, asserted in oauth-server.test.ts.
    const membershipFree = ROUTES.filter((r) => r.auth.kind === 'authenticated').map(
      (r) => `${r.method} ${r.path}`,
    )
    expect(membershipFree.sort()).toEqual([
      'GET /oauth/authorize',
      'GET /workspaces',
      'POST /invitations/accept',
      'POST /oauth/authorize',
      'POST /workspaces',
    ])
  })

  it('WS-4 AC4: no two routes share a method and path', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('WS-4 AC4: only health and well-known endpoints are fully public', () => {
    const publicPaths = ROUTES.filter((r) => r.auth.kind === 'public').map((r) => r.path)
    for (const path of publicPaths) {
      expect(
        path.startsWith('/healthz') ||
          path.startsWith('/readyz') ||
          path.startsWith('/metrics') ||
          path.startsWith('/.well-known/') ||
          path.startsWith('/auth/') ||
          path.startsWith('/oauth/') ||
          path.startsWith('/__test/'),
        `${path} is public but is not a health, auth or well-known endpoint`,
      ).toBe(true)
    }
  })
})
