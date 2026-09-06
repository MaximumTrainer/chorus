import { NotFoundError, ValidationError, ulid } from '@chorus/core'
import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Structure proposals and the confirmation gate (CHAT-5).
 *
 * > The guarantee that nothing is written before confirmation must be
 * > structural — enforced by the data model — and not merely a UI convention.
 *
 * So a proposal is data in one column, not rows in `tasks` behind a status
 * filter. Tasks come into existence at confirmation, in one transaction, or
 * not at all: half a task tree is worse than none, because somebody then has
 * to work out which half is missing.
 */

export interface ProposalNode {
  readonly key: string
  readonly title: string
  readonly summary?: string
  readonly type?: string
  readonly tags?: readonly string[]
  readonly size?: string
  readonly children?: readonly ProposalNode[]
}

export interface ProposalTree {
  readonly nodes: readonly ProposalNode[]
}

export type ProposalStatus = 'proposed' | 'confirmed' | 'edited_and_confirmed' | 'rejected'

export interface ProposalRecord {
  readonly id: string
  readonly teamId: string
  readonly sessionId: string | null
  readonly tree: ProposalTree
  readonly confirmedTree: ProposalTree | null
  readonly status: ProposalStatus
  readonly feedback: string | null
  readonly taskIds: readonly string[]
  readonly createdAt: string
}

export interface ProposalService {
  propose(input: {
    workspaceId: string
    teamId: string
    sessionId?: string
    runId?: string
    tree: unknown
  }): Promise<ProposalRecord>
  get(workspaceId: string, proposalId: string): Promise<ProposalRecord>
  /**
   * The team a session belongs to.
   *
   * Read from the session rather than taken from the request, so a proposal
   * cannot be pointed at another team's board by whoever composes the call.
   */
  teamForSession(workspaceId: string, sessionId: string): Promise<string>
  confirm(input: {
    workspaceId: string
    proposalId: string
    actorId: string
    /** The edited tree, when the person changed it before accepting (AC3). */
    tree?: unknown
  }): Promise<ProposalRecord>
  reject(input: {
    workspaceId: string
    proposalId: string
    actorId: string
    feedback: string
  }): Promise<ProposalRecord>
}

/** A tree is only worth storing if every node could become a task. */
export function parseTree(value: unknown): ProposalTree {
  const invalid = (detail: string): never => {
    throw new ValidationError(detail, { field: 'tree' })
  }
  if (typeof value !== 'object' || value === null || !Array.isArray((value as ProposalTree).nodes)) {
    return invalid('tree must be an object with a nodes array')
  }

  const keys = new Set<string>()
  const node = (raw: unknown, depth: number): ProposalNode => {
    if (typeof raw !== 'object' || raw === null) return invalid('every node must be an object')
    const candidate = raw as Record<string, unknown>
    // Depth is bounded here and not only at task creation, because the failure
    // this prevents is a tree that validates, is shown to somebody, is accepted
    // and only then turns out to be unmakeable.
    if (depth > 5) return invalid('the tree is nested deeper than tasks allow')
    if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
      return invalid('every node needs a title')
    }
    const key = typeof candidate.key === 'string' && candidate.key !== '' ? candidate.key : ulid()
    if (keys.has(key)) return invalid(`two nodes share the key "${key}"`)
    keys.add(key)

    const children = Array.isArray(candidate.children) ? candidate.children : []
    return {
      key,
      title: candidate.title.trim(),
      ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}),
      ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
      ...(typeof candidate.size === 'string' ? { size: candidate.size } : {}),
      tags: Array.isArray(candidate.tags)
        ? candidate.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      children: children.map((child) => node(child, depth + 1)),
    }
  }

  return { nodes: (value as ProposalTree).nodes.map((raw) => node(raw, 1)) }
}

interface ProposalRow {
  id: string
  team_id: string
  session_id: string | null
  tree: ProposalTree
  confirmed_tree: ProposalTree | null
  status: ProposalStatus
  feedback: string | null
  created_at: Date
}

export function createProposalService(config: DbConfig): ProposalService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  const COLUMNS = `id, team_id, session_id, tree, confirmed_tree, status, feedback, created_at`

  const load = async (t: TenantTx, proposalId: string): Promise<ProposalRow> => {
    const [row] = await t.query<ProposalRow>(
      `SELECT ${COLUMNS} FROM structure_proposals WHERE id = $1`,
      [proposalId],
    )
    if (!row) throw new NotFoundError('No such proposal', { proposalId })
    return row
  }

  const taskIdsOf = async (t: TenantTx, proposalId: string): Promise<string[]> =>
    (
      await t.query<{ task_id: string }>(
        `SELECT task_id FROM structure_proposal_tasks WHERE proposal_id = $1 ORDER BY task_id`,
        [proposalId],
      )
    ).map((row) => row.task_id)

  const toRecord = (row: ProposalRow, taskIds: readonly string[]): ProposalRecord => ({
    id: row.id,
    teamId: row.team_id,
    sessionId: row.session_id,
    tree: row.tree,
    confirmedTree: row.confirmed_tree,
    status: row.status,
    feedback: row.feedback,
    taskIds,
    createdAt: row.created_at.toISOString(),
  })

  return {
    async propose(input) {
      const tree = parseTree(input.tree)
      return tx(input.workspaceId, async (t) => {
        const id = ulid()
        await t.execute(
          `INSERT INTO structure_proposals (id, workspace_id, team_id, session_id, run_id, tree)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            id,
            input.workspaceId,
            input.teamId,
            input.sessionId ?? null,
            input.runId ?? null,
            JSON.stringify(tree),
          ],
        )
        return toRecord(await load(t, id), [])
      })
    },

    async teamForSession(workspaceId, sessionId) {
      return tx(workspaceId, async (t) => {
        const [row] = await t.query<{ team_id: string }>(
          `SELECT team_id FROM chat_sessions WHERE id = $1 AND deleted_at IS NULL`,
          [sessionId],
        )
        if (!row) throw new NotFoundError('No such session', { sessionId })
        return row.team_id
      })
    },

    async get(workspaceId, proposalId) {
      return tx(workspaceId, async (t) => {
        const row = await load(t, proposalId)
        return toRecord(row, await taskIdsOf(t, proposalId))
      })
    },

    async confirm(input) {
      return tx(
        input.workspaceId,
        async (t) => {
          const row = await load(t, input.proposalId)

          // A retried request is the ordinary case, not the exotic one: a
          // dropped response and a refresh both look exactly like this. So the
          // second confirmation returns the first one's answer rather than
          // building a second tree (AC5).
          if (row.status === 'confirmed' || row.status === 'edited_and_confirmed') {
            return toRecord(row, await taskIdsOf(t, input.proposalId))
          }
          if (row.status === 'rejected') {
            throw new ValidationError('a rejected proposal cannot be confirmed', {
              proposalId: input.proposalId,
            })
          }

          const edited = input.tree !== undefined
          const tree = edited ? parseTree(input.tree) : row.tree

          const [counter] = await t.query<{ next_number: number }>(
            `INSERT INTO task_counters (workspace_id, team_id, next_number)
             VALUES ($1, $2, 1)
             ON CONFLICT (workspace_id, team_id) DO UPDATE SET next_number = task_counters.next_number
             RETURNING next_number`,
            [input.workspaceId, row.team_id],
          )
          let nextNumber = counter!.next_number

          const created: Array<{ id: string; key: string }> = []
          const write = async (node: ProposalNode, parentId: string | null): Promise<void> => {
            const id = ulid()
            await t.execute(
              `INSERT INTO tasks
                 (id, workspace_id, team_id, parent_id, key, title, description, tags, size, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
              [
                id,
                input.workspaceId,
                row.team_id,
                parentId,
                `CH-${nextNumber++}`,
                node.title,
                JSON.stringify(
                  node.summary
                    ? { type: 'doc', content: [{ type: 'paragraph', text: node.summary }] }
                    : {},
                ),
                node.tags ?? [],
                node.size ?? null,
                input.actorId,
              ],
            )
            await t.execute(
              `INSERT INTO structure_proposal_tasks (workspace_id, proposal_id, task_id, node_key)
               VALUES ($1, $2, $3, $4)`,
              [input.workspaceId, input.proposalId, id, node.key],
            )
            created.push({ id, key: node.key })
            for (const child of node.children ?? []) await write(child, id)
          }

          for (const node of tree.nodes) await write(node, null)

          await t.execute(
            `UPDATE task_counters SET next_number = $3 WHERE workspace_id = $1 AND team_id = $2`,
            [input.workspaceId, row.team_id, nextNumber],
          )
          await t.execute(
            `UPDATE structure_proposals
                SET status = $2, confirmed_tree = $3::jsonb, decided_by = $4, decided_at = now()
              WHERE id = $1`,
            [
              input.proposalId,
              edited ? 'edited_and_confirmed' : 'confirmed',
              edited ? JSON.stringify(tree) : null,
              input.actorId,
            ],
          )

          return toRecord(await load(t, input.proposalId), await taskIdsOf(t, input.proposalId))
        },
        input.actorId,
      )
    },

    async reject(input) {
      if (input.feedback.trim() === '') {
        // Rejection without a reason gives the next turn nothing to do
        // differently, which makes the rejection a dead end rather than a
        // correction (AC4).
        throw new ValidationError('feedback is required when rejecting', { field: 'feedback' })
      }
      return tx(
        input.workspaceId,
        async (t) => {
          const row = await load(t, input.proposalId)
          if (row.status !== 'proposed') {
            throw new ValidationError(`a ${row.status} proposal cannot be rejected`, {
              proposalId: input.proposalId,
            })
          }
          await t.execute(
            `UPDATE structure_proposals
                SET status = 'rejected', feedback = $2, decided_by = $3, decided_at = now()
              WHERE id = $1`,
            [input.proposalId, input.feedback, input.actorId],
          )
          return toRecord(await load(t, input.proposalId), [])
        },
        input.actorId,
      )
    },
  }
}
