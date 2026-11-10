import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import {
  createEntityStore,
  createWikiCompiler,
  createWikiMirror,
  type WikiMirrorPage,
  type WikiMirrorTarget,
} from '../../src/index.js'

/**
 * INT-9 AC7 — mirroring the compiled wiki into a Confluence space.
 *
 * Pages appear in the space, and a page a person hand-edited is protected by the
 * same rule as a git edit: the mirror never overwrites it, and an edit made on
 * the Confluence side runs back through the compiler's own `reconcileHumanEdit`,
 * which marks the page and raises a review item.
 */

/** An in-memory mirror target, standing in for the Confluence space. */
function fakeSpace(): WikiMirrorTarget & { readonly published: WikiMirrorPage[] } {
  const published: WikiMirrorPage[] = []
  return {
    published,
    async publish(page) {
      published.push(page)
    },
  }
}

describe('INT-9 wiki mirror (AC7)', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspaceWithPages(): Promise<{ workspaceId: string; featureEntityId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.execute(`DELETE FROM wiki_pages WHERE workspace_id = $1`, [workspaceId])
    await db.admin.execute(`DELETE FROM entities WHERE workspace_id = $1`, [workspaceId])

    const featureEntityId = ulid()
    const topicEntityId = ulid()
    await db.admin.execute(
      `INSERT INTO entities (id, workspace_id, kind, external_id, name) VALUES ($1, $2, 'feature', 'f:1', 'Billing')`,
      [featureEntityId, workspaceId],
    )
    await db.admin.execute(
      `INSERT INTO entities (id, workspace_id, kind, external_id, name) VALUES ($1, $2, 'topic', 't:1', 'Payments')`,
      [topicEntityId, workspaceId],
    )

    // Two compiled pages: one plain, one already hand-edited.
    await db.admin.execute(
      `INSERT INTO wiki_pages (id, workspace_id, entity_id, slug, kind, markdown, content_hash)
       VALUES ($1, $2, $3, 'billing', 'feature', '# Billing', 'h1')`,
      [ulid(), workspaceId, featureEntityId],
    )
    await db.admin.execute(
      `INSERT INTO wiki_pages (id, workspace_id, entity_id, slug, kind, markdown, content_hash, human_edited_at)
       VALUES ($1, $2, $3, 'payments', 'topic', '# Payments (hand-edited)', 'h2', now())`,
      [ulid(), workspaceId, topicEntityId],
    )
    return { workspaceId, featureEntityId }
  }

  it('INT-9 AC7: the mirror publishes pages to the space but never a hand-edited one', async () => {
    const { workspaceId } = await workspaceWithPages()
    const space = fakeSpace()

    const result = await createWikiMirror({ config: db.config, target: space }).mirror(workspaceId)

    expect(result.state).toBe('mirrored')
    expect(result.mirrored).toBe(1)
    expect(result.protectedPages).toBe(1)
    // Only the plain page reached the space; the hand-edited one is protected.
    expect(space.published.map((p) => p.slug)).toEqual(['billing'])
  })

  it('INT-9 AC7: an edit made in Confluence follows the same protection rules as a git edit', async () => {
    const { workspaceId, featureEntityId } = await workspaceWithPages()
    const compiler = createWikiCompiler(db.config)

    // The Confluence-side edit runs through the same reconcile the git path uses.
    const reconciled = await compiler.reconcileHumanEdit({
      workspaceId,
      entityId: featureEntityId,
      editedMarkdown: '# Billing, corrected in Confluence',
      editedBy: 'Ada Lovelace',
    })
    expect(reconciled.reconciled).toBe(true)

    // The page is now marked hand-edited, and a review item surfaces the divergence.
    const [page] = await db.admin.query<{ human_edited_at: Date | null }>(
      `SELECT human_edited_at FROM wiki_pages WHERE entity_id = $1`,
      [featureEntityId],
    )
    expect(page!.human_edited_at).not.toBeNull()
    const items = await createEntityStore(db.config).reviewItems(workspaceId)
    expect(items.some((i) => i.kind === 'stale')).toBe(true)

    // And the mirror now protects it — it is no longer pushed to the space.
    const space = fakeSpace()
    await createWikiMirror({ config: db.config, target: space }).mirror(workspaceId)
    expect(space.published.map((p) => p.slug)).not.toContain('billing')
  })
})
