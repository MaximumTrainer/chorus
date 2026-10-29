import { withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * The team home read model (NAV-2).
 *
 * One screen answering "what is happening and what needs me": recent sessions,
 * proposals awaiting confirmation, the coding queue, and the checkpoint inbox.
 * It is a read across four tables, each bounded to a handful of rows with the
 * true total beside them, so a busy team sees a page rather than a firehose
 * (AC6) and the surface can offer "and N more" into the full list.
 *
 * It reads; it never writes and never decides. What leaves a section is decided
 * by the routes that settle those items — a checkpoint decision, a proposal
 * confirmation — and this simply does not see a settled one on the next read
 * (AC3). Whether the queue's launch actions are offered is the caller's role,
 * resolved by the route, not by this read.
 */

/** How many rows each section shows before it links out to the full list (AC6). */
export const HOME_SECTION_LIMIT = 5

export interface HomeSessionCard {
  readonly id: string
  readonly title: string
  readonly entryPoint: string
  readonly createdAt: string
}

export interface HomeProposalCard {
  readonly id: string
  readonly sessionId: string | null
  readonly nodeCount: number
  readonly createdAt: string
}

export interface HomeJobCard {
  readonly id: string
  readonly taskId: string
  readonly status: string
  readonly branch: string | null
  readonly createdAt: string
}

export interface HomeCheckpointCard {
  readonly id: string
  readonly runId: string
  readonly kind: string
  readonly stepId: string
  readonly createdAt: string
}

/** A bounded slice of a section, with the full count behind it. */
export interface HomeSection<T> {
  readonly items: readonly T[]
  readonly total: number
}

export interface TeamHome {
  readonly recentSessions: HomeSection<HomeSessionCard>
  readonly awaitingProposals: HomeSection<HomeProposalCard>
  /** The queue everyone can see; `canLaunch` gates whether its launch actions are offered (AC5). */
  readonly codingQueue: HomeSection<HomeJobCard> & { readonly canLaunch: boolean }
  readonly checkpoints: HomeSection<HomeCheckpointCard>
}

export interface HomeService {
  read(input: {
    workspaceId: string
    teamId: string
    /** Whether the caller's role may launch coding jobs — the queue's action gate (AC5). */
    canLaunch: boolean
  }): Promise<TeamHome>
}

/** The states that make a coding job part of the live queue rather than history. */
const ACTIVE_JOB_STATES = ['awaiting_approval', 'queued', 'running']

export function createHomeService(config: DbConfig): HomeService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(workspaceId, fn, { config })

  return {
    async read({ workspaceId, teamId, canLaunch }) {
      return tx(workspaceId, async (t) => {
        const count = async (sql: string, params: unknown[]): Promise<number> => {
          const [row] = await t.query<{ n: string }>(sql, params)
          return Number(row?.n ?? 0)
        }

        // Recent sessions.
        const sessionRows = await t.query<{
          id: string
          title: string
          entry_point: string
          created_at: Date
        }>(
          `SELECT id, title, entry_point, created_at
             FROM chat_sessions
            WHERE workspace_id = $1 AND team_id = $2 AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT $3`,
          [workspaceId, teamId, HOME_SECTION_LIMIT],
        )
        const sessionTotal = await count(
          `SELECT count(*)::text AS n FROM chat_sessions
            WHERE workspace_id = $1 AND team_id = $2 AND deleted_at IS NULL`,
          [workspaceId, teamId],
        )

        // Proposals awaiting confirmation.
        const proposalRows = await t.query<{
          id: string
          session_id: string | null
          tree: { nodes?: unknown[] }
          created_at: Date
        }>(
          `SELECT id, session_id, tree, created_at
             FROM structure_proposals
            WHERE workspace_id = $1 AND team_id = $2 AND status = 'proposed'
            ORDER BY created_at DESC
            LIMIT $3`,
          [workspaceId, teamId, HOME_SECTION_LIMIT],
        )
        const proposalTotal = await count(
          `SELECT count(*)::text AS n FROM structure_proposals
            WHERE workspace_id = $1 AND team_id = $2 AND status = 'proposed'`,
          [workspaceId, teamId],
        )

        // The coding queue: jobs that are not yet finished.
        const jobRows = await t.query<{
          id: string
          task_id: string
          status: string
          branch: string | null
          created_at: Date
        }>(
          `SELECT id, task_id, status, branch, created_at
             FROM coding_jobs
            WHERE workspace_id = $1 AND team_id = $2 AND status = ANY($3)
            ORDER BY created_at DESC
            LIMIT $4`,
          [workspaceId, teamId, ACTIVE_JOB_STATES, HOME_SECTION_LIMIT],
        )
        const jobTotal = await count(
          `SELECT count(*)::text AS n FROM coding_jobs
            WHERE workspace_id = $1 AND team_id = $2 AND status = ANY($3)`,
          [workspaceId, teamId, ACTIVE_JOB_STATES],
        )

        // The checkpoint inbox: pending gates on this team's runs, not yet
        // expired. Checkpoints carry no team of their own; the run does, so the
        // join is what scopes the inbox to the team whose home this is.
        const checkpointRows = await t.query<{
          id: string
          run_id: string
          kind: string
          step_id: string
          created_at: Date
        }>(
          `SELECT c.id, c.run_id, c.kind, c.step_id, c.created_at
             FROM checkpoints c
             JOIN runs r ON r.id = c.run_id
            WHERE c.workspace_id = $1 AND r.team_id = $2 AND c.status = 'pending'
              AND (c.expires_at IS NULL OR c.expires_at > now())
            ORDER BY c.created_at DESC
            LIMIT $3`,
          [workspaceId, teamId, HOME_SECTION_LIMIT],
        )
        const checkpointTotal = await count(
          `SELECT count(*)::text AS n
             FROM checkpoints c
             JOIN runs r ON r.id = c.run_id
            WHERE c.workspace_id = $1 AND r.team_id = $2 AND c.status = 'pending'
              AND (c.expires_at IS NULL OR c.expires_at > now())`,
          [workspaceId, teamId],
        )

        return {
          recentSessions: {
            total: sessionTotal,
            items: sessionRows.map((row) => ({
              id: row.id,
              title: row.title,
              entryPoint: row.entry_point,
              createdAt: row.created_at.toISOString(),
            })),
          },
          awaitingProposals: {
            total: proposalTotal,
            items: proposalRows.map((row) => ({
              id: row.id,
              sessionId: row.session_id,
              nodeCount: Array.isArray(row.tree?.nodes) ? row.tree.nodes.length : 0,
              createdAt: row.created_at.toISOString(),
            })),
          },
          codingQueue: {
            canLaunch,
            total: jobTotal,
            items: jobRows.map((row) => ({
              id: row.id,
              taskId: row.task_id,
              status: row.status,
              branch: row.branch,
              createdAt: row.created_at.toISOString(),
            })),
          },
          checkpoints: {
            total: checkpointTotal,
            items: checkpointRows.map((row) => ({
              id: row.id,
              runId: row.run_id,
              kind: row.kind,
              stepId: row.step_id,
              createdAt: row.created_at.toISOString(),
            })),
          },
        }
      })
    },
  }
}
