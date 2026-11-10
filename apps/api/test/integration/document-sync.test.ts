import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from '@chorus/core'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { createDocumentSync, type DocumentSync } from '../../src/document-sync.js'

/**
 * INT-9 AC6 — two-way edits arrive as suggestions, never overwrites.
 *
 * A document published to Confluence is edited there; when two-way sync is on,
 * the edit is raised as a suggested change beside the document and the document
 * itself is left exactly as it was.
 */
describe('INT-9 two-way document sync (AC6)', () => {
  let db: IsolatedDatabase
  let sync: DocumentSync

  beforeAll(async () => {
    db = await createIsolatedDatabase()
    sync = createDocumentSync(db.config)
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function workspaceWithDocument(body: string): Promise<{ workspaceId: string; documentId: string }> {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const teamId = (
      await db.admin.query<{ id: string }>(`SELECT id FROM teams WHERE workspace_id = $1 LIMIT 1`, [workspaceId])
    )[0]!.id
    const userId = (
      await db.admin.query<{ user_id: string }>(
        `SELECT user_id FROM workspace_members WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId],
      )
    )[0]!.user_id
    const documentId = ulid()
    await db.admin.execute(
      `INSERT INTO documents (id, workspace_id, team_id, type, title, body_md_cache, created_by)
       VALUES ($1, $2, $3, 'freeform', 'Runbook', $4, $5)`,
      [documentId, workspaceId, teamId, body, userId],
    )
    return { workspaceId, documentId }
  }

  it('INT-9 AC6: a Confluence edit on a two-way link becomes a suggestion, leaving the document unchanged', async () => {
    const { workspaceId, documentId } = await workspaceWithDocument('# Runbook\n\nRaise the timeout.')
    await sync.linkDocument({ workspaceId, documentId, externalKind: 'confluence:page', externalId: 'PAGE-1', twoWay: true })

    const result = await sync.reconcileExternalEdit({
      workspaceId,
      externalKind: 'confluence:page',
      externalId: 'PAGE-1',
      bodyMarkdown: '# Runbook\n\nRaise the timeout to 120s.',
      author: 'Ada Lovelace',
    })

    expect(result).not.toBeNull()

    // A suggestion set and its suggestion exist, holding the external edit.
    const [set] = await db.admin.query<{ status: string; instruction: string; created_by: string }>(
      `SELECT status, instruction, created_by FROM document_suggestion_sets WHERE id = $1`,
      [result!.suggestionSetId],
    )
    expect(set!.status).toBe('ready')
    expect(set!.instruction).toContain('Ada Lovelace')
    expect(set!.created_by).toBe(`usr_integration_${workspaceId}`)

    const [suggestion] = await db.admin.query<{ original_text: string; replacement_text: string }>(
      `SELECT original_text, replacement_text FROM document_suggestions WHERE set_id = $1`,
      [result!.suggestionSetId],
    )
    expect(suggestion!.original_text).toBe('# Runbook\n\nRaise the timeout.')
    expect(suggestion!.replacement_text).toBe('# Runbook\n\nRaise the timeout to 120s.')

    // The document itself is byte-identical to before — never overwritten.
    const [doc] = await db.admin.query<{ body_md_cache: string }>(
      `SELECT body_md_cache FROM documents WHERE id = $1`,
      [documentId],
    )
    expect(doc!.body_md_cache).toBe('# Runbook\n\nRaise the timeout.')
  })

  it('INT-9 AC6: a one-way link ignores the edit (no suggestion)', async () => {
    const { workspaceId, documentId } = await workspaceWithDocument('# Runbook')
    await sync.linkDocument({ workspaceId, documentId, externalKind: 'confluence:page', externalId: 'PAGE-2', twoWay: false })

    const result = await sync.reconcileExternalEdit({
      workspaceId,
      externalKind: 'confluence:page',
      externalId: 'PAGE-2',
      bodyMarkdown: '# Runbook changed',
    })
    expect(result).toBeNull()
  })

  it('INT-9 AC6: an edit that matches the document raises nothing', async () => {
    const { workspaceId, documentId } = await workspaceWithDocument('# Same')
    await sync.linkDocument({ workspaceId, documentId, externalKind: 'confluence:page', externalId: 'PAGE-3', twoWay: true })

    const result = await sync.reconcileExternalEdit({
      workspaceId,
      externalKind: 'confluence:page',
      externalId: 'PAGE-3',
      bodyMarkdown: '# Same',
    })
    expect(result).toBeNull()
  })
})
