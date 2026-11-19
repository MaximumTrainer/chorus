import type { Mailer } from './auth.js'

/**
 * A mail transport for a deployment that has none (NFR-1 AC1).
 *
 * Sign-up requires a verified address, so without some transport a fresh
 * install is one that nobody can enter. Writing each message to the server's
 * log gives the operator, who is the first person to sign up anyway, the link
 * they need. Every line is a warning and says why, because mail that silently
 * goes to a log is mail an operator believes was delivered.
 *
 * The messages carry single-use links, so the log is as sensitive as an inbox
 * for the few minutes those links are live.
 */
export function createLogMailer(log: (line: string) => void): Mailer {
  return {
    send(message) {
      log(
        JSON.stringify({
          level: 'warn',
          message: 'no mail transport is configured, so this email was written to the log instead of sent',
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      )
      return Promise.resolve()
    },
  }
}
