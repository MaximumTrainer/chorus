import { describe, it, expect } from 'vitest'
import { createLogMailer } from './log-mailer.js'

describe('NFR-1 log mail transport', () => {
  it('NFR-1 AC1: writes each message as one JSON line naming its recipient, subject and text', async () => {
    const lines: string[] = []
    const mailer = createLogMailer((line) => lines.push(line))

    await mailer.send({ to: 'ada@example.test', subject: 'Verify', text: 'Open http://x.test/verify?token=t' })

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn',
      to: 'ada@example.test',
      subject: 'Verify',
      text: 'Open http://x.test/verify?token=t',
    })
  })

  it('NFR-1 AC1: says why the mail was logged rather than sent', async () => {
    const lines: string[] = []
    await createLogMailer((line) => lines.push(line)).send({ to: 'a@b.test', subject: 's', text: 't' })
    expect(JSON.parse(lines[0]!).message).toMatch(/no mail transport is configured/i)
  })
})
