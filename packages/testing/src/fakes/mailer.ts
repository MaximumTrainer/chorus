/**
 * A mail transport that records instead of sending (CLAUDE.md §4).
 *
 * Shipped code rather than a per-test stub: WS-1 verification, WS-2
 * invitations, DOC-4 mention notifications and SLACK-6 checkpoint delivery all
 * need to assert what was sent, and a fake reinvented per suite drifts from
 * what the real transport does.
 */

export interface SentMail {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly html?: string
  /**
   * The first URL in the message, if any. Verification and invitation flows are
   * asserted by following the link a real recipient would click, rather than by
   * reaching into the database for a token — which would pass even if the email
   * never contained a usable link.
   */
  readonly verificationUrl?: string
}

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>
}

export interface RecordingMailer extends Mailer {
  readonly sent: readonly SentMail[]
  clear(): void
  /** Messages addressed to one recipient, most recent last. */
  to(address: string): readonly SentMail[]
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/

export function createRecordingMailer(): RecordingMailer {
  const sent: SentMail[] = []

  return {
    async send(message) {
      const body = `${message.text}\n${message.html ?? ''}`
      const match = URL_PATTERN.exec(body)
      sent.push({
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(match ? { verificationUrl: match[0] } : {}),
      })
    },
    get sent() {
      return sent
    },
    clear() {
      sent.length = 0
    },
    to(address) {
      return sent.filter((mail) => mail.to.toLowerCase() === address.toLowerCase())
    },
  }
}
