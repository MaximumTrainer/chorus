import { ulid } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'

/**
 * Every MCP call, attributed (MCP-5 AC3, architecture.md §14).
 *
 * A session is recorded as a run of `mcp-session`, started by the person the
 * agent acts for, and each tool call as a `tool_call` event on it. So "what
 * did my agent do" is answered by the same trace route as any workflow's, and
 * by nothing new. The run is created by the session's first call rather than
 * at initialisation: a client that connects and never calls has done nothing
 * worth a row.
 *
 * The client's name is what the client said about itself. It is logged so a
 * person can recognise their tool, and is never used to decide anything.
 */

export const MCP_SESSION_WORKFLOW = 'mcp-session'

export interface McpCallEntry {
  readonly client: string
  readonly userId: string
  readonly tool: string
  readonly outcome: 'ok' | 'error'
  readonly durationMs: number
}

export interface McpCallLog {
  /** Records one call on the session's run, creating the run on the first. */
  record(session: McpLoggedSession, entry: McpCallEntry): Promise<void>
}

/** What the log keeps about one session between calls. */
export interface McpLoggedSession {
  readonly workspaceId: string
  /** Known once the transport has issued it, which is after the session object exists. */
  sessionId: string
  runId?: string
}

export function createMcpCallLog(config: DbConfig): McpCallLog {
  return {
    async record(session, entry) {
      await withTenant(
        session.workspaceId,
        async (t) => {
          if (!session.runId) {
            const runId = ulid()
            await t.execute(
              `INSERT INTO runs (id, workspace_id, workflow_name, workflow_version, status, trigger, started_by)
               VALUES ($1, $2, $3, 1, 'running', $4, $5)`,
              [
                runId,
                session.workspaceId,
                MCP_SESSION_WORKFLOW,
                JSON.stringify({ kind: 'mcp', client: entry.client, sessionId: session.sessionId }),
                entry.userId,
              ],
            )
            session.runId = runId
          }
          await t.execute(
            `INSERT INTO run_events (id, workspace_id, run_id, seq, kind, payload)
             SELECT $1, $2, $3, COALESCE(MAX(seq), 0) + 1, 'tool_call', $4
               FROM run_events WHERE run_id = $3`,
            [ulid(), session.workspaceId, session.runId, JSON.stringify(entry)],
          )
        },
        { config, userId: entry.userId },
      )
    },
  }
}
