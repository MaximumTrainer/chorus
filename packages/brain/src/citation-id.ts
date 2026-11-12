import { createHash } from 'node:crypto'

/**
 * Citation ids for entity fragments (BRAIN-11 AC5).
 *
 * A citation id must be stable across retrievals of the same fragment so two
 * bundles can be compared, and must change when what it points at changes, so a
 * citation never silently keeps pointing at a fact that has moved. The two
 * authorities earn that property from different places:
 *
 * - A **brain-authored** entity's facts are Chorus's own — its summary is prose
 *   the compiler wrote — so its id is derived from the entity id and that
 *   summary. A changed summary is a changed citation.
 * - An **external-authority** entity's facts belong to the owning source. Its id
 *   is derived from its `externalUri` (the stable address of the thing) plus a
 *   provenance hash of the facts the source holds — its kind, name and
 *   attributes — so a re-sync that changes nothing leaves the id alone, and a
 *   changed source fact yields a changed id. The synthesised summary does *not*
 *   enter it: the id addresses the source, not the sentence Chorus wrote.
 */

export interface EntityCitationInput {
  readonly entityId: string
  readonly kind: string
  readonly name: string
  readonly authority: string
  readonly externalUri: string | null
  readonly attributes: Record<string, unknown>
}

/**
 * A canonical JSON string for hashing: object keys are emitted in sorted order
 * at every level, so a value the source re-serialised with its keys in another
 * order hashes the same. Arrays keep their order, which is meaningful.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * The provenance hash of an external entity — a digest of the facts its owning
 * source holds. A re-sync that changes nothing leaves it unchanged; a changed
 * fact changes it.
 */
export function provenanceHash(input: Pick<EntityCitationInput, 'kind' | 'name' | 'attributes'>): string {
  return createHash('sha256')
    .update(canonical({ kind: input.kind, name: input.name, attributes: input.attributes }))
    .digest('hex')
    .slice(0, 16)
}

/** The citation id for an entity fragment, keyed on its authority (see the module note). */
export function entityCitationId(input: EntityCitationInput, summaryText: string): string {
  if (input.authority === 'external' && input.externalUri) {
    return createHash('sha256')
      .update(`external ${input.externalUri} ${provenanceHash(input)}`)
      .digest('hex')
      .slice(0, 16)
  }
  return createHash('sha256').update(`entity ${input.entityId} `).update(summaryText).digest('hex').slice(0, 16)
}
