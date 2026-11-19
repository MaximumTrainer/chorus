import { createServer, type Server, type Socket } from 'node:net'

/**
 * A minimal SMTP server, for proving that mail actually leaves over SMTP
 * (NFR-1 AC1).
 *
 * It speaks the RFC 5321 subset a client needs to hand over one message:
 * greeting, EHLO/HELO, MAIL FROM, RCPT TO, DATA, RSET, NOOP and QUIT. It never
 * advertises STARTTLS or AUTH, so a client talks plain text to it, and it
 * accepts every message. What it received is kept as the envelope plus the raw
 * message, so a test asserts on what went over the wire rather than on what a
 * transport object says it did.
 */

export interface ReceivedMail {
  readonly from: string
  readonly to: readonly string[]
  /** The message exactly as sent in DATA, headers and body, dot-unstuffed. */
  readonly raw: string
}

export interface FakeSmtpServer {
  readonly port: number
  /** `smtp://127.0.0.1:<port>`, as an operator would set CHORUS_SMTP_URL. */
  readonly url: string
  readonly received: readonly ReceivedMail[]
  close(): Promise<void>
}

export async function startFakeSmtpServer(): Promise<FakeSmtpServer> {
  const received: ReceivedMail[] = []
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')

    let buffer = ''
    let inData = false
    let from = ''
    let to: string[] = []
    let data: string[] = []

    const reply = (line: string): void => {
      socket.write(`${line}\r\n`)
    }
    const address = (argument: string): string => /<([^>]*)>/.exec(argument)?.[1] ?? argument.trim()

    reply('220 fake-smtp ready')

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\r\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        newline = buffer.indexOf('\r\n')

        if (inData) {
          if (line === '.') {
            inData = false
            received.push({ from, to, raw: data.join('\r\n') })
            from = ''
            to = []
            data = []
            reply('250 2.0.0 queued')
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line)
          }
          continue
        }

        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') {
          reply('250-fake-smtp')
          reply('250 8BITMIME')
        } else if (verb === 'HELO') reply('250 fake-smtp')
        else if (line.toUpperCase().startsWith('MAIL FROM:')) {
          from = address(line.slice(10))
          reply('250 2.1.0 ok')
        } else if (line.toUpperCase().startsWith('RCPT TO:')) {
          to.push(address(line.slice(8)))
          reply('250 2.1.5 ok')
        } else if (verb === 'DATA') {
          inData = true
          reply('354 end with <CRLF>.<CRLF>')
        } else if (verb === 'RSET') {
          from = ''
          to = []
          data = []
          reply('250 2.0.0 ok')
        } else if (verb === 'NOOP') reply('250 2.0.0 ok')
        else if (verb === 'QUIT') {
          reply('221 2.0.0 bye')
          socket.end()
        } else reply('502 5.5.2 command not implemented')
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  return {
    port,
    url: `smtp://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
