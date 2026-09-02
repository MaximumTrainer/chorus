import { describe, it, expect } from 'vitest'
import { CONNECTOR_KINDS, SignalSchema, parseSignal, type Signal } from './signals.js'

/**
 * INT-1 AC6 — the Signal envelope, validated at the boundary.
 *
 * A Signal is immutable and carries provenance, so it is the one shape in the
 * system that must never be half-populated: a signal missing its `occurredAt`
 * or its permission scope is not a slightly worse signal, it is a row that
 * retrieval will later either mis-order or mis-permission. Validating at the
 * connector boundary is what stops a connector author's mistake becoming a
 * permanent bad row that nobody can attribute.
 */

const valid: Signal = {
  source: 'reference',
  externalId: 'msg-1',
  kind: 'message',
  text: 'the deploy is broken',
  structured: { channel: 'general' },
  author: { externalId: 'u-1', display: 'Ada' },
  occurredAt: new Date('2026-09-02T10:00:00.000Z'),
  url: 'https://example.test/msg-1',
  permissions: { visibility: 'restricted', scopeIds: ['channel-general'] },
  raw: { id: 'msg-1' },
}

describe('INT-1 the Signal envelope', () => {
  it('INT-1 AC6: a complete signal is accepted unchanged', () => {
    expect(parseSignal(valid)).toEqual(valid)
  })

  it('INT-1 AC6: provenance is mandatory — a signal cannot be anonymous about where it came from', () => {
    for (const field of ['source', 'externalId', 'kind', 'occurredAt', 'permissions'] as const) {
      const without: Record<string, unknown> = { ...valid }
      delete without[field]
      expect(() => parseSignal(without), `${field} must be required`).toThrow()
    }
  })

  it('INT-1 AC6: an unknown source is refused, so a typo does not become a new source', () => {
    // Signals are deduplicated per integration and queried by source. A
    // misspelled source silently creates a second, invisible corpus.
    expect(() => parseSignal({ ...valid, source: 'githbu' })).toThrow()
    expect(CONNECTOR_KINDS).toContain('github')
  })

  it('INT-1 AC6: an empty external id is refused, because dedup depends on it', () => {
    // `(integration_id, external_id, kind)` is the uniqueness key. An empty id
    // collapses every signal from a connector into one row.
    expect(() => parseSignal({ ...valid, externalId: '' })).toThrow()
    expect(() => parseSignal({ ...valid, kind: '' })).toThrow()
  })

  it('INT-1 AC6: text and author and url are nullable, but must be present as null', () => {
    // A commit has no text; a system event has no author. Nullable is right;
    // *absent* is not, because absent is indistinguishable from forgotten.
    const sparse = parseSignal({ ...valid, text: null, author: null, url: null })
    expect(sparse).toMatchObject({ text: null, author: null, url: null })

    const withoutText: Record<string, unknown> = { ...valid }
    delete withoutText.text
    expect(() => parseSignal(withoutText)).toThrow()
  })

  it('INT-1 AC6: permission scope is captured at ingest, and restricted means scoped', () => {
    // Retrieval re-checks these. A restricted signal with no scope ids would be
    // either invisible to everyone or visible to everyone, depending on how the
    // predicate is written — and both are wrong.
    expect(() =>
      parseSignal({ ...valid, permissions: { visibility: 'restricted', scopeIds: [] } }),
    ).toThrow()

    expect(
      parseSignal({ ...valid, permissions: { visibility: 'public', scopeIds: [] } }).permissions,
    ).toMatchObject({ visibility: 'public' })
  })

  it('INT-1 AC6: an unknown visibility is refused rather than treated as public', () => {
    expect(() =>
      parseSignal({ ...valid, permissions: { visibility: 'internal', scopeIds: ['x'] } }),
    ).toThrow()
  })

  it('INT-1 AC6: occurredAt accepts an ISO string, because that is what a webhook carries', () => {
    const fromWire = parseSignal({ ...valid, occurredAt: '2026-09-02T10:00:00.000Z' })
    expect(fromWire.occurredAt).toBeInstanceOf(Date)
    expect(fromWire.occurredAt.toISOString()).toBe('2026-09-02T10:00:00.000Z')

    expect(() => parseSignal({ ...valid, occurredAt: 'yesterday' })).toThrow()
  })

  it('INT-1 AC6: the failure names the field, so a connector author can fix it', () => {
    // A validation error that says only "invalid" turns a five-minute fix into
    // an afternoon of bisecting a payload.
    expect(() => parseSignal({ ...valid, externalId: 42 })).toThrow(/externalId/)
  })

  it('INT-1 AC6: labels are optional, because most sources have none', () => {
    const labelled = parseSignal({
      ...valid,
      permissions: { visibility: 'restricted', scopeIds: ['s'], labels: ['confidential'] },
    })
    expect(labelled.permissions.labels).toEqual(['confidential'])
    expect(parseSignal(valid).permissions.labels).toBeUndefined()
  })

  it('INT-1 AC6: the schema is the definition — nothing else may narrow it', () => {
    // Asserted so the schema and the type cannot drift: if the type were
    // hand-maintained alongside the schema, one of them would be wrong.
    const parsed: Signal = SignalSchema.parse(valid)
    expect(parsed.source).toBe('reference')
  })
})
