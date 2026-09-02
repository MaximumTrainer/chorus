import { z } from 'zod'

/**
 * The Signal envelope (architecture.md §10.1, INT-1 AC6).
 *
 * Every connector's output arrives in this one shape, and it is validated at
 * the connector boundary rather than trusted. A Signal is immutable and carries
 * the provenance that retrieval later depends on, so a half-populated one is
 * not a slightly worse signal — it is a permanent row that will be mis-ordered
 * or mis-permissioned, with nothing left to attribute the mistake to.
 *
 * Declared as a Zod schema in `core` because CLAUDE.md §10 makes that the
 * single definition of every wire shape, and the TypeScript type is *inferred*
 * from it. A hand-written type maintained alongside a schema is two
 * definitions, and one of them is always the wrong one.
 */

/**
 * The sources a signal may come from (architecture.md §17.1).
 *
 * `reference` is the framework's own scriptable connector. It ships rather than
 * living in a test file because the contract kit runs against it, and a kit that
 * only ever ran against test-local fixtures would not prove that the interface
 * is implementable by anyone else.
 */
export const CONNECTOR_KINDS = [
  'reference',
  'github',
  'gitlab',
  'linear',
  'jira',
  'confluence',
  'slack',
  'teams',
  'notion',
  'google_drive',
  'figma',
  'miro',
  'transcripts',
  'clickup',
  'amplitude',
  'mixpanel',
  'mcp',
] as const

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * Permission scope, captured at ingest and re-checked at retrieval (§10.5).
 *
 * A `restricted` signal must name what restricts it. With an empty scope list
 * the retrieval predicate either matches nothing or matches everything
 * depending on how it is written, and both readings are wrong — so the shape
 * refuses to express it.
 */
export const SignalPermissionsSchema = z
  .object({
    visibility: z.enum(['public', 'restricted']),
    scopeIds: z.array(z.string()),
    labels: z.array(z.string()).optional(),
  })
  .refine((value) => value.visibility === 'public' || value.scopeIds.length > 0, {
    message: 'a restricted signal must name at least one permission scope id',
    path: ['scopeIds'],
  })

export const SignalSchema = z.object({
  source: z.enum(CONNECTOR_KINDS),
  /** Unique within an integration. Half of the dedup key, so it cannot be empty. */
  externalId: z.string().min(1),
  kind: z.string().min(1),
  /** Null for a signal with no prose — a commit, a deployment, a metric change. */
  text: z.string().nullable(),
  /** Source-shaped fields a connector chose to lift out of `raw`. */
  structured: z.unknown(),
  author: z
    .object({ externalId: z.string().min(1), display: z.string() })
    .nullable(),
  /**
   * Coerced, because a webhook carries an ISO string and a pull may carry a
   * Date. Rejecting an unparseable value rather than defaulting to now(): a
   * signal timestamped with its ingest time is silently misfiled forever.
   */
  occurredAt: z.coerce.date(),
  url: z.string().nullable(),
  permissions: SignalPermissionsSchema,
  /** The untouched source payload, kept so a mapping bug is diagnosable later. */
  raw: z.unknown(),
})

export type Signal = z.infer<typeof SignalSchema>
export type SignalPermissions = z.infer<typeof SignalPermissionsSchema>

/**
 * Validates one signal, naming the field that failed.
 *
 * The field name is the difference between a five-minute fix and an afternoon
 * bisecting a payload, and connector authors are the audience.
 */
export function parseSignal(candidate: unknown): Signal {
  return SignalSchema.parse(candidate)
}
