import { z } from 'zod'

/**
 * Entity candidates from the deterministic extraction pass (architecture.md
 * §10.3, INT-2 AC5).
 *
 * Two passes make the product brain, and this is the first: entities the source
 * *already defines* are created without a model. A tracker issue is a `ticket`,
 * a repository is a `repo`, a chat user is a `person`. There is nothing to infer
 * and therefore nothing to get wrong, so spending a model call on it would be
 * both slower and less accurate than reading the field.
 *
 * A candidate is not yet an entity. Resolution against what already exists —
 * alias, then trigram, then embedding — is BRAIN-3's job, and so is persistence.
 * A connector's responsibility ends at "here is what this signal plainly says
 * exists", which is why this shape carries evidence and no identity.
 */

/** The entity kinds the deterministic pass can produce (architecture.md §10.3). */
export const ENTITY_KINDS = [
  'ticket',
  'person',
  'repo',
  'feature',
  'component',
  'topic',
  'page',
  'metric',
  'experiment',
  'design',
  'decision',
  // Operational kinds (BRAIN-11): facts an external graph owns, referenced here
  // rather than re-extracted. They always carry external authority.
  'service',
  'environment',
  'deployment',
  'resource',
] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

/**
 * The kinds whose authority is always an external system (BRAIN-11). An entity
 * of one of these kinds is a reference — the owning graph holds its facts — so
 * it must declare `authority: 'external'` and a parseable `externalUri`.
 */
export const EXTERNAL_AUTHORITY_KINDS = ['service', 'environment', 'deployment', 'resource'] as const

export type ExternalAuthorityKind = (typeof EXTERNAL_AUTHORITY_KINDS)[number]

export function isExternalAuthorityKind(kind: string): kind is ExternalAuthorityKind {
  return (EXTERNAL_AUTHORITY_KINDS as readonly string[]).includes(kind)
}

/**
 * Split an external uri like `sdlckg://Environment/prod-eu` into its parts, or
 * null when it is not a parseable `<scheme>://<type>/<id>`. The id may itself
 * contain slashes; only the first two segments are structural.
 */
export function parseExternalUri(uri: string): { scheme: string; type: string; id: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)\/(.+)$/i.exec(uri)
  if (!match) return null
  return { scheme: match[1]!, type: match[2]!, id: match[3]! }
}

/** The edge kinds the LLM pass may propose between entities (architecture.md §10.3, BRAIN-3). */
export const EDGE_KINDS = [
  'implements',
  'mentions',
  'depends_on',
  'owned_by',
  'measured_by',
  'decided_in',
  'duplicates',
  'blocks',
  'relates_to',
] as const

export type EdgeKind = (typeof EDGE_KINDS)[number]

/** A proposed edge between two candidate entities, each named by its external id. */
export const EdgeCandidateSchema = z.object({
  kind: z.enum(EDGE_KINDS),
  fromExternalId: z.string().min(1),
  toExternalId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.object({
    signalExternalId: z.string().min(1),
    source: z.string().min(1),
  }),
})

export type EdgeCandidate = z.infer<typeof EdgeCandidateSchema>

export const EntityCandidateSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  /**
   * The source's own identifier, namespaced by source. Resolution matches on
   * this first, so two signals about the same issue must produce the same
   * value or the brain grows one entity per mention.
   */
  externalId: z.string().min(1),
  name: z.string().min(1),
  /** Other names the same thing goes by — a key, a handle, a short code. */
  aliases: z.array(z.string()).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
  /**
   * The signal this was read from.
   *
   * Mandatory: an entity with no evidence cannot be re-derived when an
   * extractor version changes, and cannot be explained to someone asking why
   * the brain believes it.
   */
  evidence: z.object({
    signalExternalId: z.string().min(1),
    source: z.string().min(1),
    /**
     * The character range in the signal that justifies this, when the LLM pass
     * cites one. Absent for the deterministic pass, which reads a whole field
     * the source defined and cites the signal rather than a span (AC2).
     */
    charStart: z.number().int().min(0).optional(),
    charEnd: z.number().int().min(0).optional(),
  }),
  /**
   * Who owns this entity's facts (BRAIN-11). Left unset it means `brain` — one
   * Chorus extracted and may merge or rewrite. `external` means an owning system
   * holds the facts and this is only a reference, addressed by `externalUri`;
   * the extractor may link to it but never create, merge or contradict it. It is
   * optional so the deterministic and LLM passes, which only ever produce brain
   * entities, need not name it; the store applies the `brain` default.
   */
  authority: z.enum(['brain', 'external']).optional(),
  /** The owning system's address for an external-authority entity. */
  externalUri: z.string().optional(),
})
  .superRefine((value, ctx) => {
    // An operational kind is always external; it must say so rather than leave
    // it to be inferred.
    if (isExternalAuthorityKind(value.kind) && value.authority !== 'external') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authority'],
        message: `a ${value.kind} is a reference to an external system, so its authority must be 'external'`,
      })
    }
    const external = value.authority === 'external' || isExternalAuthorityKind(value.kind)
    if (external && (!value.externalUri || parseExternalUri(value.externalUri) === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['externalUri'],
        message: 'an external-authority entity needs a parseable externalUri (<scheme>://<type>/<id>)',
      })
    }
  })

export type EntityCandidate = z.infer<typeof EntityCandidateSchema>

export function parseEntityCandidate(candidate: unknown): EntityCandidate {
  return EntityCandidateSchema.parse(candidate)
}
