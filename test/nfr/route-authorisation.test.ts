import { describe, it, expect } from 'vitest'
import { ROUTES, type RouteDefinition } from '@chorus/api'

/**
 * WS-4 AC4 — every route declares the role and scope it requires.
 *
 * The point of making the requirement *declarative data* rather than a check
 * inside each handler is that it can be enumerated. A forgotten check is then
 * impossible: a route can only be wrong, never silently unguarded. This suite
 * is what turns that from an intention into a build failure.
 *
 * plan.md §5 requires this to grow automatically — every new route appears here
 * without anyone remembering to add it.
 */
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
      } else {
        expect(['member', 'senior_member', 'admin', 'owner']).toContain(route.auth.role)
        expect(Array.isArray(route.auth.scopes)).toBe(true)
      }
    },
  )

  it('WS-4 AC4: no two routes share a method and path', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('WS-4 AC4: only health and well-known endpoints are public', () => {
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
