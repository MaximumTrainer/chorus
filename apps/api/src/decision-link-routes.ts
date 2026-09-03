import { ConflictError, NotFoundError, ValidationError } from '@chorus/core'
import {
  CHECKPOINT_COLUMNS,
  decideCheckpoint,
  isCheckpointDecision,
  toCheckpointRecord,
  type CheckpointRow,
  type DecisionLinks,
} from '@chorus/agent'
import { withTenant, type DbConfig } from '@chorus/db'
import { route, type RouteDefinition } from './routes.js'
import type { RunResumer } from './run-routes.js'

/**
 * Deciding a checkpoint from an emailed link (SLACK-6 AC2).
 *
 * These two routes are public in the sense that they carry no session — the
 * token *is* the credential, which is the only way a link in an email can work
 * at all. Everything about them is therefore written around limiting what a
 * leaked one can do:
 *
 * - It reaches one checkpoint, for one person, and nothing else. It is not a
 *   session and confers no other access.
 * - Viewing does not spend it. Mail clients prefetch links, and a token
 *   consumed by being looked at would be gone before the recipient saw it.
 * - Deciding spends it, conditionally, so two clicks cannot both settle.
 * - An *unknown* token is refused without saying why, because that is where
 *   probing would happen. An already-spent one is answered with the outcome:
 *   the person presenting it demonstrably held it — guessing 256 bits to land
 *   on a consumed row is not a threat model — and "you already decided this,
 *   and here is what you decided" is the only useful thing to tell someone who
 *   clicked twice.
 */
export function decisionLinkRoutes(
  config: DbConfig,
  links: DecisionLinks,
  resumeRun?: RunResumer,
): RouteDefinition[] {
  const readCheckpoint = async (workspaceId: string, checkpointId: string) => {
    const [row] = await withTenant(
      workspaceId,
      (tx) =>
        tx.query<CheckpointRow>(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = $1`, [
          checkpointId,
        ]),
      { config },
    )
    if (!row) throw new NotFoundError('No such checkpoint')
    return toCheckpointRecord(row)
  }

  /**
   * One refusal for every way a token can be no good.
   *
   * A declaration rather than an arrow, so TypeScript narrows on the call and
   * the reader is not left wondering whether the line below it can run.
   */
  function gone(): never {
    throw new NotFoundError('This link is not valid, or has already been used')
  }

  return [
    route({
      method: 'GET',
      path: '/checkpoint-decisions/:token',
      summary: 'View the checkpoint an emailed decision link refers to.',
      auth: {
        kind: 'capability',
        credential: 'checkpoint_decision_token',
        reason:
          'The token in the link is the credential. It is single-use, bound to one ' +
          'checkpoint and one recipient, expires with the gate, and grants nothing else.',
      },
      handler: async (c) => {
        const resolved = await links.resolve(c.req.param('token'))
        if (!resolved || resolved.state === 'expired') gone()

        // Deliberately not consumed, and a spent token still shows the page:
        // a prefetching mail client would otherwise spend it before the
        // recipient saw it, and someone returning to the link wants the outcome.
        return c.json(await readCheckpoint(resolved.workspaceId, resolved.checkpointId))
      },
    }),

    route({
      method: 'POST',
      path: '/checkpoint-decisions/:token',
      summary: 'Approve, approve with edits, or reject a checkpoint from an emailed link.',
      auth: {
        kind: 'capability',
        credential: 'checkpoint_decision_token',
        reason:
          'The token in the link is the credential, and this is where it is spent. The ' +
          'decision is attributed to the recipient it was issued to.',
      },
      handler: async (c) => {
        const token = c.req.param('token')
        const resolved = await links.resolve(token)
        if (!resolved || resolved.state === 'expired') gone()

        if (resolved.state === 'consumed') {
          throw new ConflictError('This link has already been used', {
            settled: await readCheckpoint(resolved.workspaceId, resolved.checkpointId),
          })
        }

        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
        if (!isCheckpointDecision(body.decision)) {
          throw new ValidationError(
            'decision must be one of approve, approve_with_edits, reject',
            { field: 'decision' },
          )
        }

        // Spent before the decision is applied, and conditionally, so two
        // clicks arriving together cannot both get through. Losing here costs
        // nothing: the checkpoint's own conditional update would refuse the
        // second anyway, and this refuses it one step earlier.
        if (!(await links.consume(token))) {
          throw new ConflictError('This link has already been used', {
            settled: await readCheckpoint(resolved.workspaceId, resolved.checkpointId),
          })
        }

        const outcome = await decideCheckpoint(config, {
          workspaceId: resolved.workspaceId,
          checkpointId: resolved.checkpointId,
          // The person the link was sent to. An approval arriving by email is
          // as attributable as one made in the app.
          decidedBy: resolved.userId,
          decision: body.decision,
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
          ...(body.decision === 'approve_with_edits' &&
          typeof body.editedPayload === 'object' &&
          body.editedPayload !== null
            ? { editedPayload: body.editedPayload as Record<string, unknown> }
            : {}),
        })

        if (outcome.kind === 'not_found') gone()
        if (outcome.kind === 'already_settled') {
          throw new ConflictError('This checkpoint has already been decided', {
            settled: outcome.checkpoint,
          })
        }

        if (resumeRun) await resumeRun(resolved.workspaceId, outcome.checkpoint.runId)

        return c.json(await readCheckpoint(resolved.workspaceId, resolved.checkpointId))
      },
    }),
  ]
}
