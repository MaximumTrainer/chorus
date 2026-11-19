import { describe, it, expect, afterEach } from 'vitest'
import { ConfigurationError } from '@chorus/core'
import { startFakeSmtpServer, type FakeSmtpServer } from '@chorus/testing'
import { createSmtpMailer } from '../../src/smtp-mailer.js'

/** NFR-1 AC1 — the SMTP transport, against a real socket. */
describe('NFR-1 SMTP mail transport', () => {
  let smtp: FakeSmtpServer | undefined

  afterEach(async () => {
    await smtp?.close()
    smtp = undefined
  })

  it('NFR-1 AC1: delivers a message with its sender, recipient, subject and text', async () => {
    smtp = await startFakeSmtpServer()
    const mailer = createSmtpMailer({ url: smtp.url, from: 'Chorus <chorus@acme.test>' })

    await mailer.send({ to: 'ada@example.test', subject: 'Verify your address', text: 'Open https://x.test/v?token=t' })

    expect(smtp.received).toHaveLength(1)
    const [mail] = smtp.received
    expect(mail).toMatchObject({ from: 'chorus@acme.test', to: ['ada@example.test'] })
    expect(mail!.raw).toMatch(/^Subject: Verify your address$/m)
    expect(mail!.raw).toContain('https://x.test/v?token=t')
  })

  it('NFR-1 AC1: a relay that refuses the connection fails the send rather than losing the mail quietly', async () => {
    smtp = await startFakeSmtpServer()
    const url = smtp.url
    await smtp.close()
    smtp = undefined

    const mailer = createSmtpMailer({ url, from: 'chorus@acme.test' })
    await expect(mailer.send({ to: 'a@b.test', subject: 's', text: 't' })).rejects.toThrow()
  })

  it('NFR-1 AC1: refuses a URL that is not smtp:// or smtps://, naming the variable', () => {
    expect(() => createSmtpMailer({ url: 'http://mail.test', from: 'a@b.test' })).toThrow(ConfigurationError)
    expect(() => createSmtpMailer({ url: 'http://mail.test', from: 'a@b.test' })).toThrow(/CHORUS_SMTP_URL/)
  })
})
