import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Signal } from '@chorus/core'
import type { WebhookRequest, WebhookSpec } from '../contract.js'
import { STREAMS, actor, at, scopeFor, str } from './streams.js'

/**
 * GitHub webhook receipt (INT-2 AC3, AC4).
 *
 * GitHub signs with HMAC-SHA256 over the raw body, presented as
 * `sha256=<hex>` in `x-hub-signature-256`, and identifies each delivery with a
 * UUID in `x-github-delivery`. The framework owns storing, deduplicating and
 * replaying; this owns only the two things that are GitHub-specific.
 */

export const githubWebhooks: WebhookSpec = {
  secretKey: 'webhookSecret',
  verification: 'signature',

  deliveryId(request: WebhookRequest) {
    return request.headers['x-github-delivery'] ?? null
  },

  verify(request: WebhookRequest, secret: string) {
    const presented = request.headers['x-hub-signature-256'] ?? ''
    const expected = `sha256=${createHmac('sha256', secret).update(request.body).digest('hex')}`

    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    // Length first: `timingSafeEqual` throws on a mismatch, and the presented
    // signature's length is entirely the caller's choice.
    return a.length === b.length && timingSafeEqual(a, b)
  },
}

const streamNamed = (name: string) => STREAMS.find((stream) => stream.name === name)!

function repositoryOf(payload: Record<string, unknown>): string {
  const repository = payload.repository as { full_name?: unknown } | undefined
  return typeof repository?.full_name === 'string' ? repository.full_name : 'unknown/unknown'
}

/**
 * Maps a delivery to signals.
 *
 * Reuses the same `toSignal` functions the sync path uses, so a pull and a
 * webhook produce byte-identical signals for the same object. Two mappings
 * would drift, and the drift would show up as duplicate rows with different
 * shapes — the dedup key is the external id, so only one of the two survives
 * and which one depends on the order they arrived.
 */
export function signalFromEvent(
  event: string,
  payload: Record<string, unknown>,
  isPrivate: (repository: string) => boolean,
): readonly Signal[] {
  const repository = repositoryOf(payload)
  const restricted = isPrivate(repository)

  switch (event) {
    case 'issues':
      return [
        streamNamed('issue').toSignal(
          payload.issue as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'issue_comment':
      return [
        streamNamed('issue_comment').toSignal(
          payload.comment as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'pull_request':
      return [
        streamNamed('pull_request').toSignal(
          payload.pull_request as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'pull_request_review_comment':
      return [
        streamNamed('review').toSignal(
          payload.comment as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'deployment':
      return [
        streamNamed('deployment').toSignal(
          payload.deployment as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'workflow_run':
      return [
        streamNamed('workflow_run').toSignal(
          payload.workflow_run as Record<string, unknown>,
          repository,
          restricted,
        ),
      ]

    case 'push':
      return pushSignals(payload, repository, restricted)

    default:
      // An event we do not map is not an error: GitHub delivers whatever the
      // installation subscribed to, and a connector that threw on the
      // unfamiliar would fail deliveries it merely has no use for.
      return []
  }
}

/**
 * A push carries its commits inline, so it needs no follow-up request.
 *
 * External ids match what the `/commits` stream produces for the same commits,
 * so a push and a later sync deduplicate against each other rather than
 * writing the same commit twice under two ids. This is also the event that will
 * drive incremental re-indexing (AC3) once there is a queue to enqueue onto —
 * `changedPaths` is collected here so that work needs no second pass.
 */
function pushSignals(
  payload: Record<string, unknown>,
  repository: string,
  restricted: boolean,
): readonly Signal[] {
  const commits = Array.isArray(payload.commits)
    ? (payload.commits as Record<string, unknown>[])
    : []

  return commits.map((commit) => {
    const author = (commit.author ?? {}) as Record<string, unknown>
    const changedPaths = [
      ...(Array.isArray(commit.added) ? (commit.added as string[]) : []),
      ...(Array.isArray(commit.modified) ? (commit.modified as string[]) : []),
      ...(Array.isArray(commit.removed) ? (commit.removed as string[]) : []),
    ]

    return {
      source: 'github',
      externalId: `${repository}@${String(commit.id)}`,
      kind: 'commit',
      text: str(commit.message),
      structured: {
        repository,
        sha: commit.id,
        ref: payload.ref ?? null,
        // What an incremental re-index needs, captured at receipt so the
        // delivery is self-contained and replayable.
        changedPaths,
      },
      author:
        actor(commit, 'author') ??
        (typeof author.email === 'string'
          ? { externalId: author.email, display: String(author.name ?? author.email) }
          : null),
      occurredAt: at(commit, 'timestamp'),
      url: str(commit.url),
      permissions: scopeFor(repository, restricted),
      raw: commit,
    }
  })
}
