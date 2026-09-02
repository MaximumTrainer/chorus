import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ConfigurationError, ValidationError } from './errors.js'

/**
 * Envelope encryption for integration credentials (INT-1 AC1).
 *
 * Two levels, for one reason. A **data key** — one per workspace — encrypts the
 * credentials. A **master key**, from the environment, encrypts the data key.
 * Rotating the master key then rewraps a handful of 32-byte keys and never
 * touches the credential ciphertext at all. The single-level alternative makes
 * rotation a migration that decrypts every secret in the system to disk on its
 * way past, which is why systems with single-level encryption never rotate.
 *
 * AES-256-GCM throughout: authenticated, so tampering is detected rather than
 * decrypted into something plausible and then stored as a credential. The
 * workspace id is the additional authenticated data, so a row copied between
 * tenants is useless rather than a cross-tenant credential read — the tenancy
 * boundary is asserted by the cryptography as well as by the policy.
 *
 * Serialised as `v1.<keyId>.<iv>.<ciphertext>.<tag>` for a wrapped key, and
 * `v1.-.<iv>.<ciphertext>.<tag>` for a payload under a data key. The key id is
 * carried so a rotation is *resumable*: an interrupted one leaves rows that can
 * still be told apart, rather than a set nobody can classify.
 */

const FORMAT = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
/** Data keys are wrapped, not stored under a key id, so this stands in. */
const NO_KEY_ID = '-'

export interface MasterKey {
  /** Names this key in every ciphertext it wraps, so rotation can find its work. */
  readonly id: string
  readonly material: Buffer
}

/** The keys available to unwrap with: the current one, plus any being rotated away from. */
export interface Keyring {
  get(id: string): MasterKey | undefined
}

export function parseMasterKey(id: string, base64: string): MasterKey {
  if (id === '' || id.includes('.')) {
    throw new ConfigurationError('A master key id must be non-empty and contain no dot', { id })
  }

  const material = Buffer.from(base64, 'base64')
  // Node's base64 decoder is lenient, so length is the check that actually
  // catches a typo. Accepting a short key would give a system that merely looks
  // encrypted.
  if (material.length !== KEY_BYTES) {
    throw new ConfigurationError(
      `A master key must be exactly ${KEY_BYTES} bytes, base64-encoded; got ${material.length}`,
      { id },
    )
  }
  return { id, material }
}

export function createKeyring(keys: readonly MasterKey[]): Keyring {
  const byId = new Map(keys.map((key) => [key.id, key]))
  return { get: (id) => byId.get(id) }
}

export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

function seal(plaintext: Buffer, key: Buffer, keyId: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [
    FORMAT,
    keyId,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.')
}

function open(sealed: string, key: Buffer, aad: string): Buffer {
  const parts = sealed.split('.')
  if (parts.length !== 5 || parts[0] !== FORMAT) {
    throw new ValidationError('Not a recognisable ciphertext', { format: parts[0] ?? null })
  }
  const [, , iv, ciphertext, tag] = parts

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv!, 'base64url'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag!, 'base64url'))
  // Throws on a bad tag, which is the point: a tampered or misattributed
  // ciphertext must fail loudly rather than yield rubbish that gets stored.
  return Buffer.concat([decipher.update(Buffer.from(ciphertext!, 'base64url')), decipher.final()])
}

/** The key id a wrapped key names, so a rotation can find what it still has to do. */
export function keyIdOf(wrapped: string): string | undefined {
  const parts = wrapped.split('.')
  return parts.length === 5 && parts[0] === FORMAT ? parts[1] : undefined
}

export function wrapDataKey(dataKey: Buffer, master: MasterKey, workspaceId: string): string {
  return seal(dataKey, master.material, master.id, workspaceId)
}

export function unwrapDataKey(wrapped: string, keyring: Keyring, workspaceId: string): Buffer {
  const id = keyIdOf(wrapped)
  if (!id) throw new ValidationError('Not a recognisable wrapped key')

  const master = keyring.get(id)
  if (!master) {
    // Named explicitly: "which key is missing" is the whole diagnosis when a
    // deployment comes up unable to read its own credentials.
    throw new ConfigurationError(
      `No master key "${id}" is configured; it is still needed to unwrap stored data keys`,
      { keyId: id },
    )
  }
  return open(wrapped, master.material, workspaceId)
}

export function encryptWithDataKey(plaintext: string, dataKey: Buffer, workspaceId: string): string {
  return seal(Buffer.from(plaintext, 'utf8'), dataKey, NO_KEY_ID, workspaceId)
}

export function decryptWithDataKey(sealed: string, dataKey: Buffer, workspaceId: string): string {
  return open(sealed, dataKey, workspaceId).toString('utf8')
}
