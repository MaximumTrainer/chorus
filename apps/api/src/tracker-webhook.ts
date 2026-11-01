import type { Signal } from '@chorus/core'

/**
 * The inbound tracker webhook, feeding status changes to the mirror (TASK-4 AC2).
 *
 * A port, like `TrackerSink`: the deployment binds it to the connector webhook
 * receiver (verify, deduplicate, persist — the INT-1 guarantees) over a
 * credential store, and a test fakes it. The route then applies whatever status
 * changes the delivery carried through `mirrorInbound`, so the mount and the
 * mirror are wired together without the route knowing how a delivery is
 * verified or which connector produced it.
 */

/** A tracker status change a delivery carried: the issue's native id and its new status. */
export interface TrackerStatusChange {
  /** The issue's id in the source system — the same id the push stored on the link. */
  readonly externalId: string
  /** The issue's new status, as the tracker names it. */
  readonly externalStatus: string
}

export interface TrackerDelivery {
  readonly state: 'processed' | 'duplicate' | 'rejected' | 'failed'
  /**
   * The workspace the integration belongs to, which the gateway resolved from
   * the integration id. The route has only the id (the endpoint is public), so
   * this is how the mirror knows whose link and task to read. Absent when the
   * integration could not be resolved, which carries no changes either.
   */
  readonly workspaceId?: string
  /** Status changes to mirror; empty unless the delivery was processed and carried one. */
  readonly changes: readonly TrackerStatusChange[]
}

export interface TrackerWebhook {
  /**
   * Verifies, deduplicates and persists a delivery, and reports the status
   * changes it carried. The integration is named by the id in the webhook URL;
   * the binding resolves its workspace, connector and signing secret.
   */
  handle(
    integrationId: string,
    request: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
  ): Promise<TrackerDelivery>
}

/**
 * The issue status changes among the signals a tracker delivery carried.
 *
 * An issue signal names the issue by its native id in `raw.id` — the same id
 * the push stored on the link, so the mirror matches without a second lookup —
 * and carries the status the tracker set in `structured.state`. A signal that
 * is not an issue, or an issue whose delivery carried no status, yields
 * nothing: there is nothing to mirror, and inventing a status would be the
 * guess this requirement forbids.
 */
export function extractStatusChanges(signals: readonly Signal[]): readonly TrackerStatusChange[] {
  return signals.flatMap((signal) => {
    if (signal.kind !== 'issue') return []
    const externalId = (signal.raw as { id?: unknown } | undefined)?.id
    const externalStatus = (signal.structured as { state?: unknown } | undefined)?.state
    if (typeof externalId !== 'string' || externalId === '') return []
    if (typeof externalStatus !== 'string' || externalStatus === '') return []
    return [{ externalId, externalStatus }]
  })
}
