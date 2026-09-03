import { describe, it, expect } from 'vitest'
import {
  DEFAULT_REDACTION_LEVEL,
  REDACTION_LEVELS,
  isRedactionLevel,
  redactBody,
  scrubSecrets,
} from '@chorus/core'

/**
 * The redaction suite (architecture.md §24, NFR-11 AC5).
 *
 * > asserts secrets and masked fields never reach logs or traces.
 *
 * The asymmetry this is built on: a false positive costs a few characters of a
 * trace, while a false negative is a live credential in a record that will be
 * backed up, exported, and read by people who were never meant to see it. So
 * the patterns are deliberately over-broad, and the tests below are mostly a
 * list of shapes that must not survive — each one a real format somebody has
 * pasted into a chat window.
 *
 * The second half matters as much as the first: a scrubber that redacted
 * everything would pass every test above and be useless, so there are tests
 * that ordinary prose survives intact.
 */
/**
 * Fixtures are assembled from fragments rather than written as literals.
 *
 * These are invented values, but they are shaped exactly like real credentials
 * — that is the entire point of them — and a scanner cannot tell the
 * difference. Written whole, they trip GitHub's push protection and block the
 * push, which teaches whoever hits it to reach for the "allow this secret"
 * button. That habit is far more dangerous than this file.
 *
 * Joining at runtime keeps every assertion exactly as strong: the scrubber sees
 * the same complete string either way. **Do not tidy these back into literals.**
 */
const join = (...parts: readonly string[]): string => parts.join('')

const PEM_KEY = join(
  '-----BEGIN RSA PRIVATE KEY-----',
  '\nMIIEowIBAAKCAQEA\n',
  '-----END RSA PRIVATE KEY-----',
)

const secrets: ReadonlyArray<readonly [string, string]> = [
  ['an OpenAI-style key', `use ${join('sk-live', '-4c9a2f7b1e6d', '8a3c5f0b7e2d9a4c6f81')} here`],
  ['a GitHub personal token', `clone with ${join('ghp', '_16C7e42F292c6912E77', '10c838347Ae178B4a')}`],
  ['a GitHub server token', join('ghs', '_1a2b3c4d5e6f7g8h', '9i0j1k2l3m4n5o6p7q8r')],
  ['a GitLab token', `set CI_TOKEN=${join('glpat', '-ux1RQFsN6TzT', '_1abcDEF')}`],
  ['a Slack bot token', join('xoxb', '-2345678901-2345678901234', '-AbCdEfGhIjKlMnOpQrStUvWx')],
  ['an AWS access key id', `${join('AKIA', 'IOSFODNN7', 'EXAMPLE')} is the id`],
  ['an AWS secret', `aws_secret_access_key = ${join('wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYEXAMPLEKEY')}`],
  ['a bearer header', `Authorization: Bearer ${join('eyJhbGciOiJIUzI1NiJ9', '.payload.signature')}`],
  [
    'a JWT on its own',
    `token ${join('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NX0', '.dBjftJeZ4CVPmB92K27u')}`,
  ],
  ['a labelled password', 'the config has password: hunter2correcthorse'],
  ['a labelled client secret', 'client_secret="s3cr3t-value-here"'],
  ['a refresh token', `refresh_token: ${join('1//0eXaMpLe', 'ReFrEsHtOkEn')}`],
  ['a PEM private key', PEM_KEY],
]

describe('NFR-11 AC5 redaction suite', () => {
  it.each(secrets)('NFR-11 AC5: %s never survives scrubbing', (_name, text) => {
    const scrubbed = scrubSecrets(text)
    expect(scrubbed).toContain('[redacted]')

    // The specific credential material is gone, not merely flagged. A scrubber
    // that appended a warning and kept the key would pass a laxer assertion.
    const material = text.match(/\S{16,}/g) ?? []
    for (const token of material) {
      expect(scrubbed, `"${token}" survived scrubbing`).not.toContain(token)
    }
  })

  it('NFR-11 AC5: scrubbing runs at every level, including the most permissive', () => {
    const key = join('sk-live', '-4c9a2f7b1e6d', '8a3c5f0b7e2d9a4c6f81')
    const text = `the key is ${key}`

    for (const level of REDACTION_LEVELS) {
      const result = redactBody(level, text)
      // `none` means "no policy-driven redaction of your own content". It has
      // never meant "keep other people's credentials", and no workspace setting
      // may opt into that — the person whose key it is did not get a vote.
      expect(JSON.stringify(result), `level ${level} retained a credential`).not.toContain(key)
    }
  })

  it('NFR-11 AC5: ordinary prose survives, or the scrubber is useless', () => {
    // Every test above would pass against a function that returned '[redacted]'
    // for everything. This is the one that stops that.
    const prose =
      'The retrieval step returned four chunks from src/server/auth.ts and the ' +
      'model proposed splitting the handler into two functions.'

    expect(scrubSecrets(prose)).toBe(prose)
  })

  it('NFR-11 AC5: identifiers that merely look long are not mistaken for secrets', () => {
    // ULIDs, commit shas and file hashes appear throughout a trace, and
    // redacting them would remove exactly the fields that make it navigable.
    const identifiers = [
      'run 01ARZ3NDEKTSV4RRFFQ69G5FAV finished',
      'at commit 9f2a6c1e8b4d7a0f3c5e2b8d1a6f4c9e7b0d3a5f',
      'chunk hash e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]

    for (const text of identifiers) {
      expect(scrubSecrets(text), `redacted a plain identifier: ${text}`).toBe(text)
    }
  })

  it('NFR-11 AC1: `structural` keeps a fingerprint and never the body', () => {
    const result = redactBody('structural', 'the sensitive body of a prompt')

    expect(result.body).toBeUndefined()
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    // Length is kept, so an empty or truncated prompt is still diagnosable
    // without the content being retained.
    expect(result.length).toBe(30)
  })

  it('NFR-11 AC1: `full` keeps nothing derived from the body, not even a hash', () => {
    const result = redactBody('full', 'the sensitive body of a prompt')

    // A hash is still derived from content. For a workspace that decided
    // nothing may be retained, "we only kept a fingerprint" is not an answer.
    expect(result).toEqual({})
  })

  it('NFR-11 AC1: two runs with the same input hash the same, and different inputs do not', () => {
    // The property `structural` exists to provide: comparing runs without
    // retaining what they contained.
    expect(redactBody('structural', 'same').hash).toBe(redactBody('structural', 'same').hash)
    expect(redactBody('structural', 'same').hash).not.toBe(redactBody('structural', 'other').hash)
  })

  it('NFR-11 AC1: the default is the level that can be changed its mind about', () => {
    // A workspace that wants full bodies opts in and has them from that moment.
    // A workspace that discovers it has been storing customer prompts for six
    // months cannot un-store them. That asymmetry decides the default.
    expect(DEFAULT_REDACTION_LEVEL).toBe('structural')
  })

  it('NFR-11: a level arriving over the wire is checked, not trusted', () => {
    expect(isRedactionLevel('structural')).toBe(true)
    expect(isRedactionLevel('partial')).toBe(false)
    expect(isRedactionLevel(undefined)).toBe(false)
  })
})
