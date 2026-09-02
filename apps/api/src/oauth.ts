import {
  ForbiddenError,
  NotFoundError,
  OAUTH_SCHEMES,
  SCOPES,
  ValidationError,
  hashApiToken,
  mintScopedSecret,
  parseScopedSecret,
  ulid,
  verifyCodeChallenge,
  type Scope,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * The platform OAuth 2.1 authorization server (WS-5 AC3, AC4, AC5).
 *
 * MCP's authorization specification requires dynamic client registration and
 * PKCE, so Chorus has to *be* an authorization server rather than consume one.
 *
 * Three properties drive the shape of everything here:
 *
 *  - **A grant belongs to a workspace.** Consent is "this client may act for me
 *    in this workspace", never "in everything I can reach". Every issued secret
 *    names that workspace (`mintScopedSecret`), so the token endpoint — which
 *    has no workspace in its path — can still resolve one inside a tenant
 *    context rather than around it.
 *  - **A spent secret is kept, not deleted.** Recognising that a dead refresh
 *    token was presented again is the whole of AC4, and a deleted row is
 *    indistinguishable from one that never existed.
 *  - **Liveness is one predicate, evaluated where the row is found.** AC5 is
 *    about there being no window, and a window is exactly what a second query
 *    or a cache introduces.
 */

/** Long enough for a person to read a consent screen, short enough to be useless if leaked. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000
/** RFC 6749 §4.1.2 recommends a maximum of ten minutes; codes are spent in seconds. */
const CODE_TTL_MS = 60 * 1000
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface ClientRegistration {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUris: readonly string[]
  readonly grantTypes: readonly string[]
  readonly responseTypes: readonly string[]
  readonly tokenEndpointAuthMethod: string
  readonly issuedAt: number
  /** Returned only at registration, and only to a confidential client. */
  readonly clientSecret?: string
}

export interface ClientRecord {
  readonly id: string
  readonly clientName: string
  readonly redirectUris: readonly string[]
  readonly tokenEndpointAuthMethod: string
  readonly clientSecretHash: string | null
}

export interface PendingAuthorization {
  readonly id: string
  readonly client: ClientRecord
  readonly scopes: readonly Scope[]
  readonly redirectUri: string
  readonly state: string | null
}

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
  readonly scopes: readonly Scope[]
}

export interface GrantSummary {
  readonly id: string
  readonly clientName: string
  readonly scopes: readonly Scope[]
  readonly createdAt: Date
}

export interface ResolvedGrant {
  readonly grantId: string
  readonly userId: string
  readonly email: string
  readonly scopes: readonly Scope[]
}

export interface OAuthService {
  registerClient(metadata: unknown): Promise<ClientRegistration>
  beginAuthorization(input: {
    clientId: string
    userId: string
    redirectUri: string
    scope: string
    codeChallenge: string
    codeChallengeMethod: string
    responseType: string
    state?: string
  }): Promise<PendingAuthorization>
  /** The pending request, if it is live and belongs to this user. */
  pending(requestId: string, userId: string): Promise<PendingAuthorization | undefined>
  approve(
    requestId: string,
    userId: string,
    workspaceId: string,
  ): Promise<{ code: string; redirectUri: string; state: string | null }>
  deny(requestId: string, userId: string): Promise<{ redirectUri: string; state: string | null }>
  exchangeCode(input: {
    clientId: string
    clientSecret?: string
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<TokenSet>
  refresh(input: {
    clientId: string
    clientSecret?: string
    refreshToken: string
  }): Promise<TokenSet>
  /** Undefined for anything not live, in this workspace, right now (AC5). */
  resolveAccessToken(workspaceId: string, presented: string): Promise<ResolvedGrant | undefined>
  listGrants(workspaceId: string, userId: string): Promise<GrantSummary[]>
  revokeGrant(workspaceId: string, userId: string, grantId: string): Promise<void>
}

/**
 * The OAuth error shape (RFC 6749 §5.2). Distinct from `AppError` because the
 * token endpoint's contract is `{error, error_description}`, and a client
 * library branches on `error` — our problem+json would be unparseable to it.
 */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

function parseScopeString(scope: string): Scope[] {
  const asked = scope.split(/\s+/).filter(Boolean)
  const unknown = asked.filter((s) => !(SCOPES as readonly string[]).includes(s))
  if (unknown.length > 0) {
    throw new OAuthError('invalid_scope', `Unknown scope: ${unknown.join(', ')}`)
  }
  // Deduplicated and ordered, so the same request always yields the same grant.
  return SCOPES.filter((s) => asked.includes(s))
}

interface ClientRow {
  id: string
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: string
  client_secret_hash: string | null
}

const clientOf = (row: ClientRow): ClientRecord => ({
  id: row.id,
  clientName: row.client_name,
  redirectUris: row.redirect_uris,
  tokenEndpointAuthMethod: row.token_endpoint_auth_method,
  clientSecretHash: row.client_secret_hash,
})

export function createOAuthService(config: DbConfig): OAuthService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /**
   * Reads and writes over the tables that carry no workspace — clients and
   * pending authorization requests.
   *
   * Not a bypass. Neither table has a `workspace_id` column or an RLS policy,
   * because neither can: registration is anonymous and choosing a workspace is
   * itself the consent step. Their safety comes from elsewhere — a registration
   * is public information by construction, and a request is bound to the user
   * who created it.
   */
  const untenanted = <T>(fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant('__none__', fn, { config })

  async function loadClient(clientId: string): Promise<ClientRecord> {
    const [row] = await untenanted((t) =>
      t.query<ClientRow>(
        `SELECT id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash
           FROM oauth_clients WHERE id = $1 AND deleted_at IS NULL`,
        [clientId],
      ),
    )
    if (!row) throw new OAuthError('invalid_client', 'No such client', 401)
    return clientOf(row)
  }

  /**
   * A confidential client must prove itself; a public one is authenticated by
   * PKCE alone, which is what OAuth 2.1 permits and what a native client or a
   * browser extension can actually do.
   */
  function authenticateClient(client: ClientRecord, presented: string | undefined): void {
    if (client.tokenEndpointAuthMethod === 'none') return
    if (!presented || !client.clientSecretHash) {
      throw new OAuthError('invalid_client', 'This client must authenticate', 401)
    }
    if (hashApiToken(presented) !== client.clientSecretHash) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401)
    }
  }

  /**
   * Revokes every token under a grant, and the grant itself.
   *
   * Called on an explicit revocation (AC5) and on refresh reuse (AC4). It takes
   * the whole grant rather than one token because on a reuse we cannot tell
   * which party was the thief — the legitimate client and the attacker are
   * indistinguishable from here, so both must lose access.
   */
  async function revokeWholeGrant(t: TenantTx, grantId: string): Promise<void> {
    await t.execute(
      `UPDATE oauth_tokens SET revoked_at = now(), updated_at = now()
        WHERE grant_id = $1 AND revoked_at IS NULL`,
      [grantId],
    )
    await t.execute(
      `UPDATE oauth_grants SET revoked_at = now(), updated_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [grantId],
    )
  }

  /** One access token and one refresh token, against a live grant. */
  async function issueTokens(
    t: TenantTx,
    input: {
      workspaceId: string
      grantId: string
      scopes: readonly Scope[]
      /** The refresh token this pair replaces, so the rotation chain is walkable. */
      parentId?: string
    },
  ): Promise<TokenSet> {
    const access = mintScopedSecret(OAUTH_SCHEMES.access, input.workspaceId)
    const refresh = mintScopedSecret(OAUTH_SCHEMES.refresh, input.workspaceId)

    for (const [kind, secret, ttl] of [
      ['access', access, ACCESS_TOKEN_TTL_MS],
      ['refresh', refresh, REFRESH_TOKEN_TTL_MS],
    ] as const) {
      await t.execute(
        `INSERT INTO oauth_tokens
           (id, workspace_id, grant_id, kind, token_hash, parent_id, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ulid(),
          input.workspaceId,
          input.grantId,
          kind,
          secret.hash,
          input.parentId ?? null,
          input.scopes,
          new Date(Date.now() + ttl),
        ],
      )
    }

    return {
      accessToken: access.plaintext,
      refreshToken: refresh.plaintext,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scopes: input.scopes,
    }
  }

  return {
    async registerClient(metadata) {
      const body = (metadata ?? {}) as {
        client_name?: unknown
        redirect_uris?: unknown
        grant_types?: unknown
        response_types?: unknown
        token_endpoint_auth_method?: unknown
        scope?: unknown
      }

      const redirectUris = body.redirect_uris
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        redirectUris.some((uri) => typeof uri !== 'string')
      ) {
        throw new OAuthError('invalid_redirect_uri', 'At least one redirect URI is required')
      }
      for (const uri of redirectUris as string[]) {
        // Parsed rather than pattern-matched: a value we cannot parse is one we
        // cannot later compare exactly, and exact comparison is what stops an
        // authorization code being redirected to an attacker.
        try {
          new URL(uri)
        } catch {
          throw new OAuthError('invalid_redirect_uri', `Not a valid URI: ${uri}`)
        }
      }

      const clientName =
        typeof body.client_name === 'string' && body.client_name.trim() !== ''
          ? body.client_name.trim().slice(0, 200)
          : 'Unnamed client'

      const authMethod =
        body.token_endpoint_auth_method === 'client_secret_post' ||
        body.token_endpoint_auth_method === 'client_secret_basic'
          ? (body.token_endpoint_auth_method as string)
          : 'none'

      const id = ulid()
      const secret = authMethod === 'none' ? undefined : mintScopedSecret('chorus_cs_', id)

      await untenanted((t) =>
        t.execute(
          `INSERT INTO oauth_clients
             (id, client_name, client_secret_hash, redirect_uris, grant_types, response_types,
              token_endpoint_auth_method, scope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            clientName,
            secret?.hash ?? null,
            redirectUris,
            Array.isArray(body.grant_types) && body.grant_types.length > 0
              ? body.grant_types
              : ['authorization_code', 'refresh_token'],
            Array.isArray(body.response_types) && body.response_types.length > 0
              ? body.response_types
              : ['code'],
            authMethod,
            typeof body.scope === 'string' ? body.scope : null,
          ],
        ),
      )

      return {
        clientId: id,
        clientName,
        redirectUris: redirectUris as string[],
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: authMethod,
        issuedAt: Math.floor(Date.now() / 1000),
        ...(secret ? { clientSecret: secret.plaintext } : {}),
      }
    },

    async beginAuthorization(input) {
      if (input.responseType !== 'code') {
        throw new OAuthError('unsupported_response_type', 'Only the authorization code flow is supported')
      }

      const client = await loadClient(input.clientId)

      // Exact match, before anything else is validated. An unregistered
      // redirect URI must never be echoed or redirected to — that is an open
      // redirect that hands authorization codes to whoever asked for them.
      if (!client.redirectUris.includes(input.redirectUri)) {
        throw new OAuthError('invalid_request', 'This redirect URI is not registered for the client')
      }

      if (input.codeChallengeMethod !== 'S256' || input.codeChallenge === '') {
        throw new OAuthError('invalid_request', 'A PKCE challenge using S256 is required')
      }

      const scopes = parseScopeString(input.scope)
      if (scopes.length === 0) {
        throw new OAuthError('invalid_scope', 'At least one scope must be requested')
      }

      const id = ulid()
      await untenanted((t) =>
        t.execute(
          `INSERT INTO oauth_authorization_requests
             (id, client_id, user_id, redirect_uri, scopes, code_challenge,
              code_challenge_method, state, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'S256', $7, $8)`,
          [
            id,
            client.id,
            input.userId,
            input.redirectUri,
            scopes,
            input.codeChallenge,
            input.state ?? null,
            new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
          ],
        ),
      )

      return { id, client, scopes, redirectUri: input.redirectUri, state: input.state ?? null }
    },

    async pending(requestId, userId) {
      const [row] = await untenanted((t) =>
        t.query<{
          id: string
          client_id: string
          redirect_uri: string
          scopes: Scope[]
          state: string | null
        }>(
          // Bound to the user who created it: an attacker cannot forge a
          // consent because they cannot create a request in the victim's name.
          `SELECT id, client_id, redirect_uri, scopes, state
             FROM oauth_authorization_requests
            WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > now()`,
          [requestId, userId],
        ),
      )
      if (!row) return undefined

      return {
        id: row.id,
        client: await loadClient(row.client_id),
        scopes: row.scopes,
        redirectUri: row.redirect_uri,
        state: row.state,
      }
    },

    async approve(requestId, userId, workspaceId) {
      const request = await this.pending(requestId, userId)
      if (!request) throw new NotFoundError('No such authorization request', { requestId })

      // The consenting user must be a member of the workspace they are granting
      // access to. Without this a person could grant a client access to any
      // workspace whose id they could guess.
      // `workspace_id` is named explicitly, not left to the policy. Migration
      // 0004 deliberately widens `workspace_members` so a user can see their
      // own rows in *any* workspace — which is what makes membership
      // discovery possible, and what makes an unqualified query here answer
      // "yes, they are a member" about the wrong workspace entirely.
      const [membership] = await tx(
        workspaceId,
        (t) =>
          t.query<{ role: string }>(
            `SELECT role FROM workspace_members
              WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [workspaceId, userId],
          ),
        userId,
      )
      if (!membership) {
        throw new NotFoundError('No such workspace', { workspaceId })
      }

      const consumed = await untenanted((t) =>
        t.execute(
          `UPDATE oauth_authorization_requests SET consumed_at = now()
            WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > now()`,
          [requestId, userId],
        ),
      )
      // Lost a race with a concurrent approval: the request is single-use, and
      // issuing a second code against it would be issuing two credentials for
      // one consent.
      if (consumed === 0) throw new NotFoundError('No such authorization request', { requestId })

      const grantId = ulid()
      const code = mintScopedSecret(OAUTH_SCHEMES.code, workspaceId)

      await tx(
        workspaceId,
        (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'oauth.grant',
            targetType: 'oauth_grant',
            targetId: grantId,
            after: { clientId: request.client.id, clientName: request.client.clientName, scopes: request.scopes },
            apply: async () => {
              await t.execute(
                `INSERT INTO oauth_grants (id, workspace_id, client_id, user_id, scopes)
                 VALUES ($1, $2, $3, $4, $5)`,
                [grantId, workspaceId, request.client.id, userId, request.scopes],
              )
              await t.execute(
                `INSERT INTO oauth_tokens
                   (id, workspace_id, grant_id, kind, token_hash, code_challenge, redirect_uri,
                    scopes, expires_at)
                 SELECT $1, $2, $3, 'code', $4, r.code_challenge, r.redirect_uri, $5, $6
                   FROM oauth_authorization_requests r WHERE r.id = $7`,
                [
                  ulid(),
                  workspaceId,
                  grantId,
                  code.hash,
                  request.scopes,
                  new Date(Date.now() + CODE_TTL_MS),
                  requestId,
                ],
              )
            },
          }),
        userId,
      )

      return { code: code.plaintext, redirectUri: request.redirectUri, state: request.state }
    },

    async deny(requestId, userId) {
      const request = await this.pending(requestId, userId)
      if (!request) throw new NotFoundError('No such authorization request', { requestId })

      await untenanted((t) =>
        t.execute(`UPDATE oauth_authorization_requests SET consumed_at = now() WHERE id = $1`, [
          requestId,
        ]),
      )
      return { redirectUri: request.redirectUri, state: request.state }
    },

    async exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
      const client = await loadClient(clientId)
      authenticateClient(client, clientSecret)

      const parsed = parseScopedSecret(OAUTH_SCHEMES.code, code)
      if (!parsed) throw new OAuthError('invalid_grant', 'That authorization code is not valid')

      const outcome = await tx(parsed.workspaceId, async (t) => {
        const [row] = await t.query<{
          id: string
          grant_id: string
          scopes: Scope[]
          code_challenge: string
          redirect_uri: string
          consumed_at: Date | null
          expires_at: Date
          client_id: string
          revoked_at: Date | null
        }>(
          `SELECT c.id, c.grant_id, c.scopes, c.code_challenge, c.redirect_uri,
                  c.consumed_at, c.expires_at, g.client_id, g.revoked_at
             FROM oauth_tokens c
             JOIN oauth_grants g ON g.id = c.grant_id
            WHERE c.token_hash = $1 AND c.kind = 'code'`,
          [parsed.hash],
        )
        if (!row) throw new OAuthError('invalid_grant', 'That authorization code is not valid')

        // A code that has already been spent is a signal, not an accident: the
        // grant is revoked for the same reason a reused refresh token revokes
        // one — we cannot tell who the second caller was.
        // Revoked after this transaction commits, not inside it: a throw here
        // would roll the revocation back along with everything else, leaving
        // the incident detected and the grant untouched.
        if (row.consumed_at) return { kind: 'replayed', grantId: row.grant_id } as const
        if (row.revoked_at || row.expires_at.getTime() <= Date.now()) {
          throw new OAuthError('invalid_grant', 'That authorization code is not valid')
        }
        if (row.client_id !== clientId) {
          throw new OAuthError('invalid_grant', 'That code was issued to a different client')
        }
        if (row.redirect_uri !== redirectUri) {
          throw new OAuthError('invalid_grant', 'The redirect URI does not match the request')
        }
        if (!verifyCodeChallenge(codeVerifier, row.code_challenge, 'S256')) {
          throw new OAuthError('invalid_grant', 'The code verifier does not match the challenge')
        }

        await t.execute(
          `UPDATE oauth_tokens SET consumed_at = now(), updated_at = now() WHERE id = $1`,
          [row.id],
        )

        return {
          kind: 'issued',
          tokens: await issueTokens(t, {
            workspaceId: parsed.workspaceId,
            grantId: row.grant_id,
            scopes: row.scopes,
          }),
        } as const
      })

      if (outcome.kind === 'replayed') {
        await tx(parsed.workspaceId, (t) => revokeWholeGrant(t, outcome.grantId))
        throw new OAuthError('invalid_grant', 'That authorization code has already been used')
      }
      return outcome.tokens
    },

    async refresh({ clientId, clientSecret, refreshToken }) {
      const client = await loadClient(clientId)
      authenticateClient(client, clientSecret)

      const parsed = parseScopedSecret(OAUTH_SCHEMES.refresh, refreshToken)
      if (!parsed) throw new OAuthError('invalid_grant', 'That refresh token is not valid')

      const outcome = await tx(parsed.workspaceId, async (t) => {
        // Deliberately not filtered on liveness: a *dead* row presented again is
        // exactly what AC4 has to recognise, and a query that excludes it would
        // make reuse indistinguishable from a token that never existed.
        const [row] = await t.query<{
          id: string
          grant_id: string
          scopes: Scope[]
          consumed_at: Date | null
          revoked_at: Date | null
          expires_at: Date
          user_id: string
          client_id: string
          grant_revoked_at: Date | null
        }>(
          `SELECT r.id, r.grant_id, r.scopes, r.consumed_at, r.revoked_at, r.expires_at,
                  g.user_id, g.client_id, g.revoked_at AS grant_revoked_at
             FROM oauth_tokens r
             JOIN oauth_grants g ON g.id = r.grant_id
            WHERE r.token_hash = $1 AND r.kind = 'refresh'`,
          [parsed.hash],
        )
        if (!row) throw new OAuthError('invalid_grant', 'That refresh token is not valid')

        if (row.client_id !== clientId) {
          throw new OAuthError('invalid_grant', 'That token was issued to a different client')
        }

        // AC4. Reuse means either the client replayed or someone stole the
        // token; from here the two are indistinguishable, so the safe reading
        // is theft and the whole grant goes.
        //
        // Reported back rather than acted on here: the revocation and its audit
        // row must *survive*, and throwing inside this transaction would roll
        // both back — leaving an incident that was detected, recorded nowhere,
        // and acted on not at all.
        if (row.consumed_at) {
          return {
            kind: 'reused',
            grantId: row.grant_id,
            tokenId: row.id,
            userId: row.user_id,
            consumedAt: row.consumed_at,
          } as const
        }

        if (row.revoked_at || row.grant_revoked_at || row.expires_at.getTime() <= Date.now()) {
          throw new OAuthError('invalid_grant', 'That refresh token is not valid')
        }

        await t.execute(
          `UPDATE oauth_tokens SET consumed_at = now(), updated_at = now() WHERE id = $1`,
          [row.id],
        )
        // The access tokens issued alongside the spent refresh token go with
        // it: rotation that left the old access token alive would mean a
        // stolen pair kept working for the rest of its hour.
        await t.execute(
          `UPDATE oauth_tokens SET revoked_at = now(), updated_at = now()
            WHERE grant_id = $1 AND kind = 'access' AND revoked_at IS NULL`,
          [row.grant_id],
        )

        return {
          kind: 'issued',
          tokens: await issueTokens(t, {
            workspaceId: parsed.workspaceId,
            grantId: row.grant_id,
            scopes: row.scopes,
            parentId: row.id,
          }),
        } as const
      })

      if (outcome.kind === 'reused') {
        const { grantId, tokenId, userId, consumedAt } = outcome
        await tx(
          parsed.workspaceId,
          (t) =>
            mutate(t, {
              workspaceId: parsed.workspaceId,
              actor: { type: 'user', id: userId },
              action: 'oauth.refresh_reused',
              targetType: 'oauth_grant',
              targetId: grantId,
              after: { clientId, tokenId, consumedAt, outcome: 'grant_revoked' },
              apply: () => revokeWholeGrant(t, grantId),
            }),
          userId,
        )
        throw new OAuthError(
          'invalid_grant',
          'That refresh token has already been used; the grant has been revoked',
        )
      }
      return outcome.tokens
    },

    async resolveAccessToken(workspaceId, presented) {
      const parsed = parseScopedSecret(OAUTH_SCHEMES.access, presented)
      if (!parsed) return undefined
      // A token minted for another workspace is not a credential here, however
      // valid it is there.
      if (parsed.workspaceId !== workspaceId) return undefined

      return tx(workspaceId, async (t) => {
        // Liveness of the token *and* of its grant, in the one statement that
        // finds it. AC5 is about there being no window, and a second query is
        // a window.
        const [row] = await t.query<{
          grant_id: string
          scopes: Scope[]
          user_id: string
          email: string
        }>(
          `SELECT a.grant_id, a.scopes, g.user_id, u.email
             FROM oauth_tokens a
             JOIN oauth_grants g ON g.id = a.grant_id
             JOIN users u ON u.id = g.user_id
            WHERE a.token_hash = $1
              AND a.kind = 'access'
              AND a.revoked_at IS NULL
              AND a.consumed_at IS NULL
              AND a.expires_at > now()
              AND g.revoked_at IS NULL
              AND g.deleted_at IS NULL
              AND u.deleted_at IS NULL`,
          [parsed.hash],
        )
        if (!row) return undefined

        // The granter must still be a member: a grant must not outlive the
        // membership that justified it.
        const [membership] = await t.query<{ role: string }>(
          `SELECT role FROM workspace_members WHERE user_id = $1 AND deleted_at IS NULL`,
          [row.user_id],
        )
        if (!membership) return undefined

        return {
          grantId: row.grant_id,
          userId: row.user_id,
          email: row.email,
          scopes: row.scopes,
        }
      })
    },

    async listGrants(workspaceId, userId) {
      const rows = await tx(
        workspaceId,
        (t) =>
          t.query<{ id: string; client_name: string; scopes: Scope[]; created_at: Date }>(
            `SELECT g.id, c.client_name, g.scopes, g.created_at
               FROM oauth_grants g
               JOIN oauth_clients c ON c.id = g.client_id
              WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.deleted_at IS NULL
              ORDER BY g.created_at DESC`,
            [userId],
          ),
        userId,
      )
      return rows.map((row) => ({
        id: row.id,
        clientName: row.client_name,
        scopes: row.scopes,
        createdAt: row.created_at,
      }))
    },

    async revokeGrant(workspaceId, userId, grantId) {
      await tx(
        workspaceId,
        async (t) => {
          const [existing] = await t.query<{ id: string; client_id: string; scopes: Scope[] }>(
            `SELECT id, client_id, scopes FROM oauth_grants
              WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND deleted_at IS NULL`,
            [grantId, userId],
          )
          // Someone else's grant and one that never existed are answered alike.
          if (!existing) throw new NotFoundError('No such grant', { grantId })

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: userId },
            action: 'oauth.revoke',
            targetType: 'oauth_grant',
            targetId: grantId,
            before: { clientId: existing.client_id, scopes: existing.scopes },
            after: { revoked: true },
            apply: () => revokeWholeGrant(t, grantId),
          })
        },
        userId,
      )
    },
  }
}

// Re-exported so the routes can answer a forbidden scope without importing
// core's error module twice over.
export { ForbiddenError, ValidationError }
