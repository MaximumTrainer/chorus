/**
 * The notification vocabulary (SLACK-6, architecture.md §8.2).
 *
 * In `core` because three places need to agree on it and a disagreement is
 * silent: the dispatcher deciding whether to send, the API validating a
 * preference, and eventually the chat surfaces rendering one. A kind that
 * exists in one list and not another is a notification nobody ever receives.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const NOTIFICATION_KINDS = [
  /** A run is waiting on a human decision (AGENT-3). */
  'checkpoint_requested',
  /** That decision was made, so the other surfaces can stop asking. */
  'checkpoint_settled',
  'job_status',
  'pull_request_opened',
  'proposal_awaiting_confirmation',
  'mention',
  'assignment',
  'digest',
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const NOTIFICATION_PRIORITIES = ['urgent', 'normal', 'low'] as const
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number]

/**
 * Kinds that gate something: a run is stopped until a person answers.
 *
 * These may not be silenced on every channel. The requirement's own words —
 * "unsubscribe must not be able to silence checkpoint requests entirely; offer
 * channel choice rather than complete opt-out" — and the reason is that muting
 * the only channel does not mute the work. The run waits regardless, and
 * nobody is coming.
 */
export const GATING_NOTIFICATION_KINDS: readonly NotificationKind[] = ['checkpoint_requested']

/** Per kind and channel, what happens when a user has expressed no preference. */
const DEFAULTS: Readonly<Record<NotificationKind, Readonly<Record<NotificationChannel, boolean>>>> =
  {
    // Both on: this one stops a run, and the cost of an unwanted email is far
    // below the cost of a gate nobody sees.
    checkpoint_requested: { in_app: true, email: true },
    // In-app only: it closes a loop rather than asking for anything.
    checkpoint_settled: { in_app: true, email: false },
    job_status: { in_app: true, email: false },
    pull_request_opened: { in_app: true, email: false },
    proposal_awaiting_confirmation: { in_app: true, email: true },
    mention: { in_app: true, email: true },
    assignment: { in_app: true, email: true },
    digest: { in_app: false, email: true },
  }

export function defaultNotificationPreference(
  kind: NotificationKind,
  channel: NotificationChannel,
): boolean {
  return DEFAULTS[kind][channel]
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
}

/**
 * Whether a preference change is allowed.
 *
 * Pure, and in `core`, because both the API route and any future settings
 * screen must refuse the same thing. Two implementations of "you may not turn
 * this off" would eventually disagree, and the disagreement would be a person
 * who stopped being told.
 */
export function mayDisable(kind: NotificationKind, channel: NotificationChannel): boolean {
  if (!GATING_NOTIFICATION_KINDS.includes(kind)) return true
  // A gating kind keeps its in-app channel. Email can be declined — that is the
  // "channel choice" the requirement asks for — but the inbox is the floor,
  // because it is the one surface every deployment has.
  return channel !== 'in_app'
}

/** A transport that can send mail. Structural, so any real or fake one fits. */
export interface MailTransport {
  send(message: {
    to: string
    subject: string
    text: string
    html?: string
  }): Promise<void>
}

/**
 * An event to be told about.
 *
 * Declared here rather than in `packages/notifications` because a feature
 * package may only reach another through a `core` interface (architecture.md
 * §7). The agent runtime raises these; the dispatcher consumes them; neither
 * imports the other.
 */
export interface NotificationEvent {
  readonly workspaceId: string
  /** The people to tell. Empty is not an error — an event may concern nobody. */
  readonly recipients: readonly string[]
  readonly kind: NotificationKind
  readonly subject: string
  readonly body?: string
  readonly targetType: string
  readonly targetId?: string
  readonly priority?: NotificationPriority
  readonly payload?: Record<string, unknown>
  /** Where the recipient goes to act. Rendered into the email as a link. */
  readonly path?: string
}

/** What a producer of events needs, and all it needs. */
export interface NotificationSink {
  notify(event: NotificationEvent): Promise<void>
}
