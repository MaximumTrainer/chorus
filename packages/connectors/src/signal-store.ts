import { ulid, type Signal } from '@chorus/core'
import type { TenantTx } from '@chorus/db'

/**
 * Writing one signal, append-only (BRAIN-1 AC2, AC3).
 *
 * Shared by the sync runner and the webhook receiver, so the two ways content
 * arrives agree on what "the same" means. The item's current version — the one
 * nothing supersedes — is compared with what arrived. Identical content is a
 * duplicate and stores nothing (AC2). Different content is a *new* signal that
 * names the one it supersedes; the old row is never updated (AC3). A change to
 * who may see the item is a change like any other, so the new scope is what
 * applies from then on.
 *
 * "Changed" means what a reader sees — the text — or who may see it — the
 * permissions, compared as `jsonb` so key order is not a change. Not the
 * metadata around it: the same item arrives by different paths with different
 * shapes (a GitHub push carries `ref` and changed paths a later API sync does
 * not, and a different URL form), and treating that as an edit would split one
 * commit into two versions (INT-2 AC3). The first arrival's metadata is kept,
 * as it always was.
 *
 * The current version is locked while it is compared, so a sync and a webhook
 * delivering the same edit together cannot both record it; the unique indexes
 * behind this make a forked history impossible even if they tried.
 */
export async function writeSignal(
  t: TenantTx,
  input: {
    readonly workspaceId: string
    readonly integrationId: string
    readonly source: string
    readonly signal: Signal
  },
): Promise<'written' | 'duplicate'> {
  const { workspaceId, integrationId, source, signal } = input
  const structured = JSON.stringify(signal.structured ?? null)
  const permissions = JSON.stringify(signal.permissions)
  const author = signal.author?.externalId ?? null

  const [current] = await t.query<{ id: string; same: boolean }>(
    `SELECT s.id,
            (s.text IS NOT DISTINCT FROM $4 AND s.permissions = $5::jsonb) AS same
       FROM signals s
      WHERE s.integration_id = $1 AND s.external_id = $2 AND s.kind = $3
        AND NOT EXISTS (SELECT 1 FROM signals newer WHERE newer.supersedes_id = s.id)
      FOR UPDATE`,
    [integrationId, signal.externalId, signal.kind, signal.text, permissions],
  )
  if (current?.same) return 'duplicate'

  const written = await t.execute(
    `INSERT INTO signals
       (id, workspace_id, integration_id, source, external_id, kind, text, structured,
        author, author_display, occurred_at, url, permissions, raw, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT DO NOTHING`,
    [
      ulid(),
      workspaceId,
      integrationId,
      source,
      signal.externalId,
      signal.kind,
      signal.text,
      structured,
      author,
      signal.author?.display ?? null,
      signal.occurredAt,
      signal.url,
      permissions,
      JSON.stringify(signal.raw ?? null),
      current?.id ?? null,
    ],
  )
  // Nothing written means another writer recorded this exact version first.
  return written > 0 ? 'written' : 'duplicate'
}
