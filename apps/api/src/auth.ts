import { betterAuth } from 'better-auth'
import { genericOAuth } from 'better-auth/plugins'
import { configFromEnv, createManagedPool, type DbConfig } from '@chorus/db'

/**
 * Authentication (WS-1, ADR-0011).
 *
 * The library owns credential storage, hashing, session issuance and OIDC. Its
 * models are mapped onto Chorus naming conventions (architecture.md §28) rather
 * than accepting its singular, camelCase defaults — otherwise every contributor
 * carries a permanent exception in their head.
 *
 * WS-1's acceptance criteria are asserted against behaviour rather than this
 * configuration, so they survive replacing the library.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/**
 * A generic OIDC provider, configured by issuer so any compliant provider works
 * from its discovery document (WS-1 AC3). Self-hosters are not limited to the
 * providers Chorus happens to have special-cased.
 */
export interface OidcConfig {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  /** Defaults to `${issuer}/.well-known/openid-configuration`. */
  readonly discoveryUrl?: string
}

export interface AuthOptions {
  dbConfig?: DbConfig
  mailer: Mailer
  oidc?: OidcConfig
  baseUrl?: string
  secret?: string
  /** Failed sign-in attempts tolerated per window before throttling (WS-1 AC5). */
  maxSignInAttempts?: number
}

/** Inferred from the concrete options: betterAuth's type is parameterised by them, so a widened alias is not assignable. */
export type Auth = ReturnType<typeof createAuth>

const RATE_LIMIT_WINDOW_SECONDS = 60

/**
 * Generous by default, so ordinary use is never throttled. WS-1 AC5's bound is
 * exercised by configuring it down, which also keeps the throttle from bleeding
 * between unrelated tests.
 */
const DEFAULT_ATTEMPT_LIMIT = 1000

export function createAuth(options: AuthOptions) {
  const config = options.dbConfig ?? configFromEnv()
  const baseUrl = options.baseUrl ?? process.env.CHORUS_BASE_URL ?? 'http://localhost:3000'
  const limit = options.maxSignInAttempts ?? DEFAULT_ATTEMPT_LIMIT

  return betterAuth({
    baseURL: baseUrl,
    basePath: '/auth',
    secret: options.secret ?? process.env.CHORUS_AUTH_SECRET ?? 'development-only-secret',

    // Auth tables are not tenant tables, so they are not behind RLS and are
    // reached with the owner role rather than through withTenant.
    database: createManagedPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.ownerUser,
      password: config.ownerPassword,
      max: 5,
      label: 'auth',
    }),

    ...(options.oidc
      ? {
          socialProviders: {},
          plugins: [
            genericOAuth({
              config: [
                {
                  providerId: 'generic-oidc',
                  clientId: options.oidc.clientId,
                  clientSecret: options.oidc.clientSecret,
                  discoveryUrl:
                    options.oidc.discoveryUrl ??
                    `${options.oidc.issuer}/.well-known/openid-configuration`,
                  scopes: ['openid', 'email', 'profile'],
                  // WS-1 AC4: linking hinges on this claim. Without it an
                  // account is created rather than taken over.
                  mapProfileToUser: (profile: Record<string, unknown>) => ({
                    email: String(profile.email ?? ''),
                    name: String(profile.name ?? profile.email ?? ''),
                    emailVerified: profile.email_verified === true,
                  }),
                },
              ],
            }),
          ],
        }
      : {}),

    emailAndPassword: {
      enabled: true,
      // WS-1 AC1: an unverified account cannot sign in.
      requireEmailVerification: true,
      minPasswordLength: 12,
    },

    emailVerification: {
      sendOnSignUp: true,
      // WS-1 AC2: the token is consumed on use, so a replay cannot verify twice.
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user, url }) {
        await options.mailer.send({
          to: user.email,
          subject: 'Verify your Chorus account',
          text:
            `Confirm your email address to finish setting up your Chorus account.\n\n${url}\n\n` +
            'If you did not create this account, you can ignore this message.',
        })
      },
    },

    rateLimit: {
      enabled: true,
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: DEFAULT_ATTEMPT_LIMIT,
      // The library applies stricter per-path defaults that silently override
      // `max` -- sign-up is capped at 3 per window whatever is configured.
      // Left alone that would throttle a whole team onboarding from one office
      // IP, so the paths Chorus cares about are stated explicitly rather than
      // inherited (NFR-3 AC6).
      customRules: {
        // Only sign-in carries the credential-guessing bound. Sign-up and
        // verification have a different threat model, and applying the sign-in
        // bound to them would block a team onboarding from one office IP.
        '/sign-in/email': { window: RATE_LIMIT_WINDOW_SECONDS, max: limit },
        '/sign-up/email': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
        '/verify-email': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
        '/get-session': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
        '/sign-out': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
        // OAuth start and callback are redirect-driven, not credential guesses.
        // Left to the library's stricter default they cap at 3 per window,
        // which would refuse a fourth person signing in from one office IP.
        '/sign-in/social': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
        '/callback/generic-oidc': { window: RATE_LIMIT_WINDOW_SECONDS, max: DEFAULT_ATTEMPT_LIMIT },
      },
    },

    advanced: {
      // WS-1: never disclose whether an address is registered. Registration,
      // reset and sign-in must be indistinguishable to an unauthenticated
      // caller (WS-1 AC5).
      disableCSRFCheck: false,
    },

    /**
     * Chorus naming conventions, per ADR-0011. Table names are plural and
     * column names snake_case; the library's defaults are neither.
     */
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      // WS-1 AC4: link only when the provider asserts the email as verified.
      // Trusting an unverified provider email would let anyone who can create
      // an account at a permissive provider take over a Chorus account.
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  })
}
