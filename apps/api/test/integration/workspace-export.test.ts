import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { createIsolatedDatabase, type IsolatedDatabase } from '@chorus/db'
import { ulid } from '@chorus/core'
import { createWorkspaceExport, EXPORT_FORMAT } from '../../src/workspace-export.js'

/**
 * NFR-4 AC4 — export is complete and verifiable.
 *
 * `seedWorkspace` plants a row in every tenant table, so "complete" is checked
 * against the schema, not against a list: every table carrying `workspace_id`
 * is either in the export with exactly its rows, or named in the manifest as
 * deliberately excluded with a reason. Secrets — wrapped keys, encrypted
 * credentials, token hashes — never leave, and the manifest says which columns
 * were held back. Every table's checksum, and the whole export's, can be
 * recomputed from the lines themselves. Nothing of another workspace appears.
 */
interface Line {
  type: 'header' | 'row' | 'manifest'
  table?: string
  row?: Record<string, unknown>
  format?: string
  workspaceId?: string
  tables?: Record<string, { rows: number; sha256: string; omittedColumns: string[] }>
  excludedTables?: Record<string, string>
  sha256?: string
}

describe('NFR-4 workspace export', () => {
  let db: IsolatedDatabase

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  async function exportOf(workspaceId: string): Promise<{ raw: string[]; lines: Line[] }> {
    const raw: string[] = []
    for await (const chunk of createWorkspaceExport(db.config).stream({ workspaceId })) raw.push(chunk)
    const text = raw.join('')
    const rawLines = text.split('\n').filter((l) => l !== '')
    return { raw: rawLines, lines: rawLines.map((l) => JSON.parse(l) as Line) }
  }

  const sha = (s: string) => createHash('sha256').update(s).digest('hex')

  it('NFR-4 AC4: every workspace table is exported with exactly its rows, or declared excluded', async () => {
    const workspaceId = ulid()
    const other = ulid()
    await db.admin.seedWorkspace(workspaceId)
    await db.admin.seedWorkspace(other)

    const { lines } = await exportOf(workspaceId)
    expect(lines[0]).toMatchObject({ type: 'header', format: EXPORT_FORMAT, workspaceId })
    const manifest = lines[lines.length - 1]!
    expect(manifest.type).toBe('manifest')

    const tables = await db.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY table_name`,
    )
    for (const { table_name } of tables) {
      const excluded = manifest.excludedTables?.[table_name]
      if (excluded) {
        expect(excluded, `${table_name} is excluded, and says why`).toMatch(/\w/)
        expect(lines.some((l) => l.table === table_name), `${table_name} must not appear`).toBe(false)
        continue
      }
      const [count] = await db.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table_name} WHERE workspace_id = $1`,
        [workspaceId],
      )
      const exported = lines.filter((l) => l.type === 'row' && l.table === table_name)
      expect(exported.length, `${table_name} rows`).toBe(Number(count!.n))
      expect(manifest.tables?.[table_name]?.rows, `${table_name} manifest count`).toBe(Number(count!.n))
    }

    // Nothing of the other workspace.
    for (const l of lines.filter((l) => l.type === 'row')) {
      expect(l.row!.workspace_id).toBe(workspaceId)
    }
  })

  it('NFR-4 AC4: every checksum can be recomputed from the export itself', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const { raw, lines } = await exportOf(workspaceId)
    const manifest = lines[lines.length - 1]!

    const rowLines = raw.filter((_, i) => lines[i]!.type === 'row')
    for (const [table, entry] of Object.entries(manifest.tables!)) {
      const mine = rowLines.filter((l) => (JSON.parse(l) as Line).table === table)
      expect(sha(mine.map((l) => `${l}\n`).join('')), `${table} checksum`).toBe(entry.sha256)
    }
    expect(sha(rowLines.map((l) => `${l}\n`).join('')), 'whole-export checksum').toBe(manifest.sha256)
  })

  it('NFR-4 AC4: secrets never leave, and the manifest says what was held back', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const { raw, lines } = await exportOf(workspaceId)
    const manifest = lines[lines.length - 1]!

    expect(Object.keys(manifest.excludedTables!)).toEqual(
      expect.arrayContaining(['workspace_data_keys', 'account_link_requests']),
    )
    expect(manifest.tables!.integrations!.omittedColumns).toContain('encrypted_credentials')
    for (const secret of ['encrypted_credentials', 'wrapped_key', 'code_verifier', 'token_hash', 'state_hash']) {
      for (const l of lines.filter((x) => x.type === 'row')) {
        expect(Object.keys(l.row!), `${l.table} must not carry ${secret}`).not.toContain(secret)
      }
    }
    // And no wrapped key material appears anywhere in the bytes.
    const [key] = await db.admin.query<{ wrapped_key: string }>(
      `SELECT wrapped_key FROM workspace_data_keys WHERE workspace_id = $1`,
      [workspaceId],
    )
    if (key) expect(raw.join('\n')).not.toContain(key.wrapped_key)
  })

  it('NFR-4 AC4: binary columns travel as base64, so the export is plain JSON', async () => {
    const workspaceId = ulid()
    await db.admin.seedWorkspace(workspaceId)
    const { lines } = await exportOf(workspaceId)
    const versions = lines.filter((l) => l.type === 'row' && l.table === 'document_versions')
    expect(versions.length).toBeGreaterThan(0)
    expect(versions[0]!.row!.snapshot).toMatchObject({ $base64: expect.any(String) })
  })
})
