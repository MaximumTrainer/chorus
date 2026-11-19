import { ulid } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'

/**
 * Embedding signals, once per distinct text (BRAIN-1 AC6, AC2).
 *
 * Signals are immutable, so vectors live in the workspace's `embedding_cache`,
 * keyed by (model, hash of the text), and a signal finds its vector by the hash
 * it was inserted with. Embedding is therefore just: find the hashes this
 * workspace's signals have that the cache does not, for this model, and ask
 * the provider for those texts — nothing else. A re-run with nothing new asks
 * for nothing (AC2); a version that only changed who may see an item, a revert,
 * or two items saying the same thing ask for nothing either (AC6).
 *
 * Batched, so one provider call covers many texts, and bounded per run so a
 * large backfill makes steady progress across runs rather than one huge call.
 */

export type SignalEmbed = (texts: readonly string[]) => Promise<readonly number[][]>

export interface SignalEmbedder {
  embedPending(workspaceId: string): Promise<{ readonly computed: number }>
}

const BATCH = 64
const MAX_PER_RUN = 2_000

export function createSignalEmbedder(
  config: DbConfig,
  options: { readonly embed: SignalEmbed; readonly model: string },
): SignalEmbedder {
  return {
    async embedPending(workspaceId) {
      let computed = 0
      while (computed < MAX_PER_RUN) {
        const pending = await withTenant(
          workspaceId,
          (t) =>
            t.query<{ content_hash: string; text: string }>(
              `SELECT DISTINCT ON (s.content_hash) s.content_hash, s.text
                 FROM signals s
                WHERE s.text IS NOT NULL AND s.text <> ''
                  AND NOT EXISTS (SELECT 1 FROM embedding_cache c
                                   WHERE c.content_hash = s.content_hash AND c.model = $1)
                ORDER BY s.content_hash
                LIMIT ${BATCH}`,
              [options.model],
            ),
          { config },
        )
        if (pending.length === 0) break

        const vectors = await options.embed(pending.map((p) => p.text))
        if (vectors.length !== pending.length) {
          throw new Error(`The embedder returned ${vectors.length} vectors for ${pending.length} texts`)
        }
        await withTenant(
          workspaceId,
          async (t) => {
            for (let i = 0; i < pending.length; i += 1) {
              // A concurrent run may have cached the same text; theirs is as good as ours.
              await t.execute(
                `INSERT INTO embedding_cache (id, workspace_id, model, content_hash, embedding)
                 VALUES ($1, $2, $3, $4, $5::vector)
                 ON CONFLICT (workspace_id, model, content_hash) DO NOTHING`,
                [ulid(), workspaceId, options.model, pending[i]!.content_hash, `[${vectors[i]!.join(',')}]`],
              )
            }
          },
          { config },
        )
        computed += pending.length
      }
      return { computed }
    },
  }
}
