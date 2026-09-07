/**
 * Strips a credential from anything a person might read.
 *
 * Shared by every provider rather than reimplemented in each, because it is the
 * kind of three-line function that drifts: one copy gains a case, the other
 * does not, and the gap is invisible until a key is sitting in a run trace.
 *
 * Provider errors reach traces and health pages that people read, and an
 * upstream is perfectly capable of echoing the key back in its own message —
 * which is exactly the case the contract kit forges (NFR-2 AC3).
 */
export function redact(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text
}
