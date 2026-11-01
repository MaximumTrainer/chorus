import { createHash } from 'node:crypto'
import { ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Wiki compilation (BRAIN-5).
 *
 * For each salient entity the compiler renders a Markdown page — what the thing
 * is, what it relates to, and the evidence behind every line — and lands it in
 * `wiki_pages`. Salience keeps the wiki to what is worth a page (AC1); every
 * related-entity and evidence line is backed by a real edge or signal, so each
 * statement traces to a source (AC2); and a content hash makes the compile
 * incremental — an unchanged entity's page is not rewritten (AC3). Committing
 * these pages to git under a bot identity is the next slice.
 */

/** An entity earns a page when its edge + evidence count reaches this. */
export const SALIENCE_THRESHOLD = 2

export interface WikiCompiler {
  compile(workspaceId: string): Promise<{ readonly compiled: number; readonly skipped: number }>
}

interface SalientRow {
  readonly entity_id: string
  readonly kind: string
  readonly name: string
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  )
}

export function createWikiCompiler(
  config: DbConfig,
  options: { readonly salienceThreshold?: number } = {},
): WikiCompiler {
  const threshold = options.salienceThreshold ?? SALIENCE_THRESHOLD
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async compile(workspaceId) {
      return tx(workspaceId, async (t) => {
        // Salient entities: those whose edges and evidence together clear the
        // threshold. An entity nobody links to or cites does not earn a page.
        const salient = await t.query<SalientRow>(
          `SELECT e.id AS entity_id, e.kind, e.name
             FROM entities e
            WHERE (
              (SELECT count(*) FROM entity_edges g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id)
              + (SELECT count(*) FROM entity_evidence v WHERE v.entity_id = e.id)
            ) >= $1
            ORDER BY e.created_at`,
          [threshold],
        )

        let compiled = 0
        let skipped = 0
        for (const entity of salient) {
          const related = await t.query<{ kind: string; name: string }>(
            `SELECT g.kind, o.name
               FROM entity_edges g
               JOIN entities o ON o.id = CASE WHEN g.from_entity_id = $1 THEN g.to_entity_id ELSE g.from_entity_id END
              WHERE g.from_entity_id = $1 OR g.to_entity_id = $1
              ORDER BY g.created_at`,
            [entity.entity_id],
          )
          const evidence = await t.query<{ external_id: string; url: string | null }>(
            `SELECT s.external_id, s.url
               FROM entity_evidence v
               JOIN signals s ON s.id = v.signal_id
              WHERE v.entity_id = $1
              ORDER BY v.created_at`,
            [entity.entity_id],
          )

          const markdown = renderPage(entity, related, evidence)
          // Hash the semantic content, not the rendered page: the page carries
          // a `compiledAt` timestamp, and hashing that would make every compile
          // look changed and defeat the incremental skip (AC3).
          const contentHash = createHash('sha256')
            .update(JSON.stringify({ kind: entity.kind, name: entity.name, related, evidence }))
            .digest('hex')
            .slice(0, 24)

          const [existing] = await t.query<{ content_hash: string; human_edited_at: Date | null }>(
            `SELECT content_hash, human_edited_at FROM wiki_pages WHERE entity_id = $1`,
            [entity.entity_id],
          )
          // Unchanged since last compile — do not rewrite (AC3). And never
          // clobber a hand-edited page; reconciling it is AC4's slice.
          if (existing && (existing.content_hash === contentHash || existing.human_edited_at)) {
            skipped += 1
            continue
          }

          await t.execute(
            `INSERT INTO wiki_pages (id, workspace_id, entity_id, slug, kind, markdown, content_hash, compiled_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now())
             ON CONFLICT (workspace_id, entity_id) DO UPDATE
               SET slug = EXCLUDED.slug, kind = EXCLUDED.kind, markdown = EXCLUDED.markdown,
                   content_hash = EXCLUDED.content_hash, compiled_at = now()`,
            [ulid(), workspaceId, entity.entity_id, slugify(entity.name), entity.kind, markdown, contentHash],
          )
          compiled += 1
        }
        return { compiled, skipped }
      })
    },
  }
}

function renderPage(
  entity: SalientRow,
  related: readonly { kind: string; name: string }[],
  evidence: readonly { external_id: string; url: string | null }[],
): string {
  const lines = [
    '---',
    `entityId: ${entity.entity_id}`,
    `kind: ${entity.kind}`,
    `compiledAt: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${entity.name}`,
    '',
    '## Summary',
    '',
    `${entity.name} is a ${entity.kind} in this workspace.`,
    '',
    '## Related',
    '',
    ...(related.length > 0
      ? related.map((r) => `- ${r.kind.replace(/_/g, ' ')} **${r.name}**`)
      : ['_No related entities yet._']),
    '',
    '## Evidence',
    '',
    // Each line resolves to the signal that justifies the page (AC2).
    ...(evidence.length > 0
      ? evidence.map((e) => `- [${e.external_id}](${e.url ?? `signal:${e.external_id}`})`)
      : ['_No evidence yet._']),
    '',
  ]
  return lines.join('\n')
}
