import nodemailer from 'nodemailer'
import { ConfigurationError } from '@chorus/core'
import type { Mailer } from './auth.js'

/**
 * Mail over SMTP (NFR-1 AC1, ADR-0025).
 *
 * Configured by one URL, `CHORUS_SMTP_URL` (`smtp://user:pass@host:587`, or
 * `smtps://` for implicit TLS), because that is the form every relay documents
 * and one variable cannot be half-set. A plain `smtp://` connection upgrades
 * with STARTTLS whenever the relay offers it.
 *
 * A send that fails throws. The caller decides what a failure means — sign-up
 * reports it, notifications record a failed delivery (§11.8) — and a transport
 * that swallowed it would turn a broken relay into mail everyone believes was
 * sent.
 */
export function createSmtpMailer(options: { readonly url: string; readonly from: string }): Mailer {
  let protocol: string
  try {
    protocol = new URL(options.url).protocol
  } catch {
    throw new ConfigurationError('CHORUS_SMTP_URL is not a valid URL; expected smtp://host:port or smtps://host:port')
  }
  if (protocol !== 'smtp:' && protocol !== 'smtps:') {
    throw new ConfigurationError(
      `CHORUS_SMTP_URL must start with smtp:// or smtps://, not ${protocol}//`,
    )
  }

  const transport = nodemailer.createTransport(options.url)

  return {
    async send(message) {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      })
    },
  }
}
