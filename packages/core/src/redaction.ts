import { createHash } from 'node:crypto'

/**
 * Redaction (NFR-11, AGENT-4 AC3, architecture.md §11.6).
 *
 * > Redaction is the control that makes such logging acceptable in
 * > environments that would otherwise forbid it entirely.
 *
 * Two rules, and the second is not negotiable by the first.
 *
 * 1. **A workspace chooses how much of a body is kept.** Its prompts are its
 *    own, and a team debugging an agent may legitimately want all of them.
 * 2. **Credential-shaped content is never kept, at any level.** The person
 *    whose key leaked into a prompt did not get a say in the workspace's
 *    policy, and a key in a trace is a key in every backup of that trace.
 *
 * Applied at **write time**, never on read. A filter over stored content is a
 * promise that every future reader remembers to apply it; a body that was never
 * written cannot be leaked by a query somebody writes next year, by a database
 * dump, or by a backup restored somewhere else.
 */

/**
 * How much of a prompt or response body is retained.
 *
 * The names describe how much *redaction* is applied, which is why `none` is
 * the most permissive:
 *
 * - `none` — bodies stored as sent and received, minus credentials.
 * - `structural` — bodies replaced by a hash and a length. Two runs can be
 *   shown to have had the same input without the input being retained.
 * - `full` — no body and no hash. A hash is still derived from content, and
 *   for a workspace that has decided nothing may be retained, "we only kept a
 *   fingerprint" is not an answer.
 *
 * The structural record — model, provider, template version, tokens, latency,
 * timing — is complete at every level. That is what separates these from
 * switching logging off.
 */
export const REDACTION_LEVELS = ['none', 'structural', 'full'] as const
export type RedactionLevel = (typeof REDACTION_LEVELS)[number]

/**
 * What a workspace gets before anybody chooses.
 *
 * `structural`, and deliberately not `none`. This is architecture.md §25's
 * open decision 10 settled in the direction that can be undone: a workspace
 * that wants full bodies opts in and gets them from that moment, whereas a
 * workspace that discovers it has been storing customer prompts for six months
 * cannot un-store them. The rationale for logging at all — making it acceptable
 * where it would otherwise be forbidden — argues the same way.
 */
export const DEFAULT_REDACTION_LEVEL: RedactionLevel = 'structural'

export function isRedactionLevel(value: unknown): value is RedactionLevel {
  return typeof value === 'string' && (REDACTION_LEVELS as readonly string[]).includes(value)
}

/**
 * Credential shapes, scrubbed at every level.
 *
 * Deliberately over-broad. A false positive costs a few characters of a trace;
 * a false negative is a live credential in a record that will be backed up,
 * exported and read by people who were never meant to see it. The asymmetry is
 * the whole design.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Provider-style keys: a recognisable prefix followed by a long opaque body.
  /\b(?:sk|pk|rk|api|key|tok)[-_](?:live|test|prod|proj)?[-_]?[A-Za-z0-9]{16,}\b/gi,
  // GitHub and GitLab tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  // Slack.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key ids, and anything labelled as a secret access key.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[=:]\s*\S+/gi,
  // PEM private keys, whole block.
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization headers, however they were quoted.
  /\b(?:authorization|proxy-authorization)\s*[=:]\s*["']?(?:bearer|basic|token)\s+\S+/gi,
  // A field that names itself. Catches `password: hunter2` and its cousins.
  /\b(?:password|passwd|secret|client_secret|private_key|access_token|refresh_token)\s*[=:]\s*["']?[^\s"',}]{4,}/gi,
]

export const REDACTED = '[redacted]'

/**
 * Removes credential-shaped content.
 *
 * Runs before any level is applied, so it holds even at `none`. Returns the
 * text with each match replaced, which keeps the surrounding sentence readable
 * — a trace reduced to `[redacted]` in its entirety tells a debugger nothing,
 * and the point is to keep everything that is not a secret.
 */
export function scrubSecrets(text: string): string {
  let scrubbed = text
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED)
  }
  return scrubbed
}

export interface RedactedBody {
  /** The text itself, when the level retains it. */
  readonly body?: string
  /** SHA-256 of the scrubbed text, when the level retains a fingerprint. */
  readonly hash?: string
  /** Character count, so a truncation or an empty prompt is still visible. */
  readonly length?: number
}

/**
 * What to persist for one prompt or response body.
 *
 * The caller spreads the result into the event payload, so a level that keeps
 * nothing contributes no keys at all rather than keys holding `undefined` —
 * which would read, to anyone querying the trace, as a body that was there and
 * empty.
 */
export function redactBody(level: RedactionLevel, text: string): RedactedBody {
  if (level === 'full') return {}

  const scrubbed = scrubSecrets(text)

  if (level === 'structural') {
    return {
      hash: createHash('sha256').update(scrubbed).digest('hex'),
      length: scrubbed.length,
    }
  }

  return {
    body: scrubbed,
    hash: createHash('sha256').update(scrubbed).digest('hex'),
    length: scrubbed.length,
  }
}
