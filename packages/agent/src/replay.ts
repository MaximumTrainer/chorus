import { NotFoundError } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'

/**
 * Replaying a run's inputs (NFR-11 AC3).
 *
 * > **Then** the exact context bundle and prompts can be reconstructed
 * > (subject to redaction) and re-submitted.
 *
 * The parenthesis is the whole design. A run under `structural` kept no bodies,
 * and the honest answer there is to say so — not to rebuild a prompt from the
 * template and today's inputs and present it as what ran. Those two things
 * differ exactly when it matters: after the template changed, after the
 * retrieved context moved on, which is when somebody is replaying in the first
 * place.
 *
 * So this returns what the run actually kept, and marks each call replayable or
 * not with the reason. What remains when the body is gone is still worth
 * having: the template's id, version and hash, and a hash of what was sent — so
 * a reconstruction can be *verified* against the original even though the
 * original text is not there to read.
 */

export interface ReplayableCall {
  readonly seq: number
  readonly step: string
  readonly model: { readonly provider: string; readonly model: string }
  /** The prompt as sent, when the run's policy retained it. */
  readonly prompt?: string
  /** SHA-256 of the prompt as sent, when the policy retained a fingerprint. */
  readonly promptHash?: string
  /** The template, so it can be fetched at the version that ran. */
  readonly template?: { readonly id: string; readonly version: number; readonly hash: string }
  readonly replayable: boolean
  /** Why not, when it is not. Phrased for whoever wanted to replay it. */
  readonly reason?: string
}

export interface Replay {
  readonly runId: string
  readonly workflow: string
  readonly calls: readonly ReplayableCall[]
}

interface EventRow {
  seq: number
  payload: {
    step?: string
    provider?: string
    model?: string
    prompt?: string
    promptHash?: string
  }
  prompt_id: string | null
  prompt_version: number | null
  prompt_hash: string | null
}

export async function replayRun(
  config: DbConfig,
  workspaceId: string,
  runId: string,
): Promise<Replay> {
  return withTenant(
    workspaceId,
    async (tx) => {
      const [run] = await tx.query<{ workflow_name: string; workflow_version: number }>(
        `SELECT workflow_name, workflow_version FROM runs WHERE id = $1`,
        [runId],
      )
      // Another workspace's run and one that never existed are alike from here.
      if (!run) throw new NotFoundError('No such run', { runId })

      const events = await tx.query<EventRow>(
        `SELECT seq, payload, prompt_id, prompt_version, prompt_hash
           FROM run_events
          WHERE run_id = $1 AND kind = 'model_call'
          ORDER BY seq`,
        [runId],
      )

      return {
        runId,
        workflow: `${run.workflow_name}@${run.workflow_version}`,
        calls: events.map((event): ReplayableCall => {
          const { payload } = event
          const template =
            event.prompt_id && event.prompt_version !== null && event.prompt_hash
              ? {
                  id: event.prompt_id,
                  version: event.prompt_version,
                  hash: event.prompt_hash,
                }
              : undefined

          const base = {
            seq: event.seq,
            step: payload.step ?? 'unknown',
            model: {
              provider: payload.provider ?? 'unknown',
              model: payload.model ?? 'unknown',
            },
            ...(template ? { template } : {}),
            ...(payload.promptHash ? { promptHash: payload.promptHash } : {}),
          }

          if (payload.prompt !== undefined) {
            return { ...base, prompt: payload.prompt, replayable: true }
          }

          return {
            ...base,
            replayable: false,
            reason: payload.promptHash
              ? 'The prompt body was redacted at write time. The template and a hash of ' +
                'what was sent remain, so a reconstruction can be verified against it.'
              : 'The prompt body and its hash were both redacted at write time. Only the ' +
                'template reference remains.',
          }
        }),
      }
    },
    { config },
  )
}
