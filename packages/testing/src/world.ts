import type { RecordingMailer } from './fakes/mailer.js'

/**
 * A world builder for acceptance tests (CLAUDE.md §4).
 *
 * Arranging "a signed-in user who owns a workspace" is the opening move of
 * almost every test from WS-2 onwards. Written once here, it keeps arrange
 * blocks readable and — more importantly — keeps every test driving the product
 * through its real entry points rather than reaching into the database to
 * fabricate state the product would never produce.
 */

/**
 * Anything with Hono's `request` shape, without depending on Hono here.
 *
 * Typed loosely on purpose: Hono's signature is generic over its env and
 * accepts more input shapes than a bare string. Narrowing it would force every
 * caller to cast their own app, which is the sort of friction that ends with
 * `as any` at each call site.
 */
export interface RequestableApp {
  // Four parameters, loosely typed: Hono's request() takes an env and an
  // execution context after the init, and a type declaring fewer parameters is
  // not assignable from one declaring more.
  request(
    input: string,
    init?: RequestInit,
    env?: unknown,
    executionCtx?: unknown,
  ): Response | Promise<Response>
}

export interface Workspace {
  readonly id: string
  readonly name: string
  readonly slug: string
}

export interface SignedInUser {
  readonly email: string
  readonly userId: string
  readonly cookie: string
  get(path: string): Promise<Response>
  post(path: string, body?: unknown): Promise<Response>
  patch(path: string, body?: unknown): Promise<Response>
  put(path: string, body?: unknown): Promise<Response>
  delete(path: string): Promise<Response>
  createWorkspace(name: string): Promise<Workspace>
}

export interface AnonymousCaller {
  get(path: string): Promise<Response>
  post(path: string, body?: unknown): Promise<Response>
}

/**
 * A caller holding a personal API token rather than a session (WS-5).
 *
 * Deliberately not a variant of `SignedInUser`: a token is a *different kind*
 * of credential, and letting one masquerade as a session in tests is how a
 * scope ceiling comes to be asserted against the wrong caller.
 */
export interface BearerCaller {
  get(path: string): Promise<Response>
  post(path: string, body?: unknown): Promise<Response>
  patch(path: string, body?: unknown): Promise<Response>
  delete(path: string): Promise<Response>
}

export interface TestClient {
  /** A verified, signed-in user. Drives the real sign-up and sign-in flow. */
  signedInUser(email?: string): Promise<SignedInUser>
  /**
   * A signed-in user holding `role` in `workspaceId`, admitted through the real
   * invitation flow rather than by writing a membership row.
   *
   * Every permission test needs one caller per role, and fabricating the
   * membership directly would test a state the product cannot actually produce
   * — the invitation path is where a role is really conferred.
   */
  memberWithRole(
    inviter: SignedInUser,
    workspaceId: string,
    role: string,
    email?: string,
  ): Promise<SignedInUser>
  anonymous(): AnonymousCaller
  /** A caller presenting `token` as an `Authorization: Bearer` credential. */
  bearer(token: string): BearerCaller
  /**
   * The most recent *invitation* link sent to an address.
   *
   * Deliberately not "the last link": an invitee also receives a verification
   * email when they sign up, and returning that instead would silently redeem
   * the wrong token and make the invitation look invalid.
   */
  lastInvitationLink(email: string): string | undefined
  /** The token carried by an invitation or verification link. */
  tokenFrom(url: string): string
}

const PASSWORD = 'correct-horse-battery-staple'

export function createTestClient(app: RequestableApp, mailer: RecordingMailer): TestClient {
  // Hono may answer synchronously, so the union is normalised once here rather
  // than at every call site.
  const send = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, init)

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  const tokenFrom = (url: string): string => {
    const parsed = new URL(url, 'http://localhost:3000')
    const fromQuery = parsed.searchParams.get('token')
    if (fromQuery) return fromQuery

    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    // Returning an empty string on a miss would make "the raw token is never
    // stored" vacuously true, so this fails loudly instead.
    if (!last) throw new Error(`no token found in link: ${url}`)
    return last
  }

  return {
    async signedInUser(email = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`) {
      await send('/auth/sign-up/email', json({ email, password: PASSWORD, name: 'Test User' }))

      const verification = mailer.to(email).at(-1)?.verificationUrl
      if (!verification) throw new Error(`no verification email was sent to ${email}`)
      await send(verification, { redirect: 'manual' })

      const signedIn = await send('/auth/sign-in/email', json({ email, password: PASSWORD }))
      const cookie = signedIn.headers.get('set-cookie')
      if (!cookie) throw new Error(`sign-in issued no session for ${email}`)

      const session = (await send('/auth/get-session', { headers: { cookie } }).then((r) =>
        r.json(),
      )) as { user?: { id?: string; email?: string } } | null
      const userId = session?.user?.id
      if (!userId) throw new Error(`no user id resolved for ${email}`)

      const withCookie = (init: RequestInit = {}): RequestInit => ({
        ...init,
        headers: { ...(init.headers as Record<string, string>), cookie },
      })

      const user: SignedInUser = {
        email,
        userId,
        cookie,
        get: (path) => send(path, withCookie()),
        post: (path, body) => send(path, withCookie(json(body))),
        patch: (path, body) => send(path, withCookie({ ...json(body), method: 'PATCH' })),
        put: (path, body) => send(path, withCookie({ ...json(body), method: 'PUT' })),
        delete: (path) => send(path, withCookie({ method: 'DELETE' })),
        async createWorkspace(name) {
          const response = await send('/workspaces', withCookie(json({ name })))
          if (response.status !== 201) {
            throw new Error(`could not create workspace: ${response.status} ${await response.text()}`)
          }
          return (await response.json()) as Workspace
        },
      }
      return user
    },

    async memberWithRole(inviter, workspaceId, role, email) {
      const address =
        email ?? `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`

      const invited = await send(
        `/workspaces/${workspaceId}/invitations`,
        {
          ...json({ email: address, role }),
          headers: { 'content-type': 'application/json', cookie: inviter.cookie },
        },
      )
      if (invited.status !== 201) {
        throw new Error(`could not invite a ${role}: ${invited.status} ${await invited.text()}`)
      }

      const user = await this.signedInUser(address)
      const link = this.lastInvitationLink(address)
      if (!link) throw new Error(`no invitation email was sent to ${address}`)

      const accepted = await user.post('/invitations/accept', { token: tokenFrom(link) })
      if (accepted.status !== 200) {
        throw new Error(`could not accept as ${role}: ${accepted.status} ${await accepted.text()}`)
      }
      return user
    },

    anonymous() {
      return {
        get: (path) => send(path),
        post: (path, body) => send(path, json(body)),
      }
    },

    bearer(token) {
      const withToken = (init: RequestInit = {}): RequestInit => ({
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${token}`,
        },
      })
      return {
        get: (path) => send(path, withToken()),
        post: (path, body) => send(path, withToken(json(body))),
        patch: (path, body) => send(path, withToken({ ...json(body), method: 'PATCH' })),
        delete: (path) => send(path, withToken({ method: 'DELETE' })),
      }
    },

    lastInvitationLink(email) {
      const invitations = mailer
        .to(email)
        .filter((mail) => mail.verificationUrl?.includes('/invitations/accept'))
      return invitations.at(-1)?.verificationUrl
    },

    tokenFrom,
  }
}
