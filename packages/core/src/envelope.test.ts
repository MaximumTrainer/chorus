import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  createKeyring,
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  parseMasterKey,
  unwrapDataKey,
  wrapDataKey,
} from './envelope.js'

/**
 * INT-1 AC1 — envelope encryption.
 *
 * A per-workspace data key encrypts the credentials; a master key from the
 * environment encrypts the data key. Rotating the master key therefore rewraps
 * a handful of small keys and never touches the ciphertext itself — which is
 * what makes rotation something you can actually do, rather than a migration
 * that decrypts every secret in the system to disk on its way past.
 *
 * The properties below are the ones that make it worth anything: authenticated
 * encryption, so tampering is detected rather than decrypted into nonsense;
 * binding to a workspace, so a wrapped key cannot be moved between rows; and a
 * key id in the ciphertext, so a rotation can be resumed rather than being
 * all-or-nothing.
 */

const master = parseMasterKey('k1', randomBytes(32).toString('base64'))
const other = parseMasterKey('k2', randomBytes(32).toString('base64'))
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('INT-1 envelope encryption', () => {
  it('INT-1 AC1: a wrapped data key round-trips, and is not the key', () => {
    const dataKey = generateDataKey()
    const wrapped = wrapDataKey(dataKey, master, WORKSPACE)

    expect(wrapped).not.toContain(dataKey.toString('base64url'))
    expect(unwrapDataKey(wrapped, createKeyring([master]), WORKSPACE)).toEqual(dataKey)
  })

  it('INT-1 AC1: a credential round-trips through its data key', () => {
    const dataKey = generateDataKey()
    const secret = JSON.stringify({ accessToken: 'ghp_notarealtoken', refreshToken: 'r' })

    const ciphertext = encryptWithDataKey(secret, dataKey, WORKSPACE)
    expect(ciphertext).not.toContain('ghp_notarealtoken')
    expect(decryptWithDataKey(ciphertext, dataKey, WORKSPACE)).toBe(secret)
  })

  it('INT-1 AC1: encryption is non-deterministic, so equal secrets do not look equal', () => {
    // A deterministic scheme leaks which workspaces share a credential, and
    // which credential was rotated to the same value it had before.
    const dataKey = generateDataKey()
    const a = encryptWithDataKey('same', dataKey, WORKSPACE)
    const b = encryptWithDataKey('same', dataKey, WORKSPACE)

    expect(a).not.toBe(b)
    expect(decryptWithDataKey(a, dataKey, WORKSPACE)).toBe('same')
    expect(decryptWithDataKey(b, dataKey, WORKSPACE)).toBe('same')
  })

  it('INT-1 AC1: tampering is detected rather than decrypted', () => {
    const dataKey = generateDataKey()
    const ciphertext = encryptWithDataKey('sensitive', dataKey, WORKSPACE)

    // Flip one character of the payload segment. Without authentication this
    // would decrypt to plausible-looking rubbish and be stored as a credential.
    const parts = ciphertext.split('.')
    parts[3] = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`

    expect(() => decryptWithDataKey(parts.join('.'), dataKey, WORKSPACE)).toThrow()
  })

  it('INT-1 AC1: a wrapped key cannot be moved to another workspace', () => {
    // The workspace is authenticated data, so a row copied between tenants is
    // useless rather than a cross-tenant credential read.
    const dataKey = generateDataKey()
    const wrapped = wrapDataKey(dataKey, master, WORKSPACE)

    expect(() =>
      unwrapDataKey(wrapped, createKeyring([master]), '01ARZ3NDEKTSV4RRFFQ69G5FB0'),
    ).toThrow()
  })

  it('INT-1 AC1: the wrong master key cannot unwrap', () => {
    const wrapped = wrapDataKey(generateDataKey(), master, WORKSPACE)

    expect(() => unwrapDataKey(wrapped, createKeyring([other]), WORKSPACE)).toThrow(/k1/)
  })

  it('INT-1 AC1: rotation rewraps the data key and leaves the ciphertext untouched', () => {
    // This is the whole point of the envelope: the expensive data never moves.
    const dataKey = generateDataKey()
    const ciphertext = encryptWithDataKey('a credential', dataKey, WORKSPACE)
    const wrapped = wrapDataKey(dataKey, master, WORKSPACE)

    const keyring = createKeyring([other, master])
    const rewrapped = wrapDataKey(unwrapDataKey(wrapped, keyring, WORKSPACE), other, WORKSPACE)

    expect(rewrapped).not.toBe(wrapped)
    // The same data key comes back out, so nothing encrypted under it changed.
    expect(unwrapDataKey(rewrapped, createKeyring([other]), WORKSPACE)).toEqual(dataKey)
    expect(decryptWithDataKey(ciphertext, dataKey, WORKSPACE)).toBe('a credential')
  })

  it('INT-1 AC1: a wrapped key names the master key that wrapped it', () => {
    // Without this a rotation is all-or-nothing: an interrupted one leaves rows
    // nobody can tell apart, and no way to know which still need rewrapping.
    const wrapped = wrapDataKey(generateDataKey(), master, WORKSPACE)
    expect(wrapped.split('.')[1]).toBe('k1')
  })

  it('INT-1 AC1: a keyring holding both keys unwraps either, which is what makes rotation resumable', () => {
    const dataKey = generateDataKey()
    const underOld = wrapDataKey(dataKey, master, WORKSPACE)
    const underNew = wrapDataKey(dataKey, other, WORKSPACE)
    const keyring = createKeyring([master, other])

    expect(unwrapDataKey(underOld, keyring, WORKSPACE)).toEqual(dataKey)
    expect(unwrapDataKey(underNew, keyring, WORKSPACE)).toEqual(dataKey)
  })

  it('INT-1 AC1: a master key must be 32 bytes, and says so if it is not', () => {
    // Silently accepting a short key would give a system that looks encrypted.
    expect(() => parseMasterKey('k', randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
    expect(() => parseMasterKey('k', 'not base64 !!')).toThrow()
    expect(() => parseMasterKey('', randomBytes(32).toString('base64'))).toThrow(/id/i)
  })

  it('INT-1 AC1: a malformed ciphertext is refused, not misread', () => {
    const dataKey = generateDataKey()
    for (const bad of ['', 'nonsense', 'v1.a.b', 'v9.k1.a.b.c']) {
      expect(() => decryptWithDataKey(bad, dataKey, WORKSPACE), bad).toThrow()
    }
  })

  it('INT-1 AC1: a data key is 256 bits of real entropy', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateDataKey().toString('base64')))
    expect(keys.size).toBe(100)
    expect(generateDataKey()).toHaveLength(32)
  })
})
