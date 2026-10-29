import { UpstreamError } from '@chorus/core'
import { z, type ZodType } from 'zod'

/**
 * Turning a model's reply into a validated value (NFR-2).
 *
 * Shared by every provider, because the tolerance and the strictness both have
 * to be identical across them or `generate` means something different depending
 * on who served the call — which is precisely what NFR-2 forbids.
 */

/**
 * Recovers the object from a reply that has prose around it.
 *
 * This is the brace-scraping that used to live in `packages/agent`'s executor,
 * moved here and given a different job. There it was the *only* parsing, so
 * every failure it had — prose, truncation, a wrong-shaped object — became
 * `undefined` and a run that silently produced nothing. Here it is a fallback
 * behind a schema the provider was actually given, and whatever it recovers is
 * still validated before anyone sees it.
 *
 * Kept rather than dropped because providers do ignore a format instruction and
 * explain themselves first, and losing a good draft to a preamble helps nobody.
 * Deliberate and tested, rather than accidental (AC4).
 */
export function objectFromText(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Not JSON on its own. Fall through to looking for one inside it.
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined

  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Validates a parsed reply, or throws saying which field was wrong.
 *
 * The message names the path and the reason, because "the model returned
 * something invalid" sends a reader to the trace to find out what, and the
 * trace is where they were going to end up anyway. Naming it here means the run
 * record already says it.
 */
export function validate<T>(value: unknown, schema: ZodType<T>, schemaName: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data

  const problems = result.error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')

  throw new UpstreamError(
    `the model returned output that does not satisfy "${schemaName}" (${problems})`,
    { schemaName, problems },
  )
}

/**
 * Parses and validates in one step, distinguishing "not an object at all" from
 * "an object of the wrong shape".
 *
 * Two different failures, and conflating them costs a reader the one fact that
 * tells them whether the prompt or the schema is at fault.
 */
export function parseStructured<T>(text: string, schema: ZodType<T>, schemaName: string): T {
  const parsed = objectFromText(text)
  if (parsed === undefined) {
    throw new UpstreamError(
      `the model was asked for "${schemaName}" and returned no JSON object at all`,
      { schemaName, replyPreview: text.slice(0, 200) },
    )
  }
  return validate(parsed, schema, schemaName)
}

/**
 * The JSON Schema a provider is given, from the Zod schema `core` owns.
 *
 * `io: 'input'` because what is being described is what the model must
 * *produce*, before any transform the schema applies on the way in.
 */
export function jsonSchemaFor(schema: ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
}

/**
 * The same schema, made strict for a provider that demands it (#199).
 *
 * Anthropic's structured outputs reject an object schema that does not set
 * `additionalProperties: false` — and it must hold for every object, however
 * deeply nested, not just the root. So this walks the schema and sets it on
 * each one. It also drops the `$schema` dialect marker, which the endpoint has
 * no use for and some reject. It does not touch `required`: optional fields
 * stay optional, which the API permits.
 *
 * Returns a copy; the input is left alone, because the same schema is also
 * given to providers that do not want it rewritten.
 */
export function strictObjectSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictObjectSchema)
  if (node === null || typeof node !== 'object') return node

  const entries = Object.entries(node as Record<string, unknown>)
    .filter(([key]) => key !== '$schema')
    .map(([key, value]) => [key, strictObjectSchema(value)] as const)
  const out: Record<string, unknown> = Object.fromEntries(entries)

  // An object schema is one that describes properties. Setting this on anything
  // with a `properties` map covers the shapes `z.toJSONSchema` emits, including
  // those whose `type` is omitted.
  if (out.type === 'object' || 'properties' in out) {
    out.additionalProperties = false
  }
  return out
}
