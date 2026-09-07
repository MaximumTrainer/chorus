/**
 * A live smoke check against the real Anthropic API (NFR-2, NFR-8).
 *
 * Everything in `packages/llm` is proven against hand-written wire samples and
 * recorded shapes, which is the right way to have built it: a test that called
 * a real model would be slow, costly and — the reason that actually matters —
 * unfalsifiable, because a real model answers plausibly whatever you send it.
 *
 * But a cassette proves the parser handles *the shape we wrote down*. It cannot
 * prove we wrote the shape down correctly. This script is the other half: it
 * makes real calls and reports what came back, so the assumptions in the
 * provider meet the endpoint at least once.
 *
 * Deliberately **not** a test, and deliberately not in any vitest project.
 * CLAUDE.md §4: "Never call a real model, a real tracker or a real network host
 * from a test." A live check that ran in CI would make the suite flaky, costly
 * and dependent on somebody else's uptime.
 *
 *   CHORUS_ANTHROPIC_API_KEY=sk-ant-... pnpm smoke:anthropic
 *
 * It spends a few cents. Nothing it does is destructive and it touches no
 * database.
 */
import {
  createAnthropicProvider,
  createProviderRegistry,
  type ModelRef,
  type TokenUsage,
} from '@chorus/llm'
import { z } from 'zod'

const KEY = process.env.CHORUS_ANTHROPIC_API_KEY?.trim()
if (!KEY) {
  console.error(
    'CHORUS_ANTHROPIC_API_KEY is not set.\n' +
      'This script makes real, billable calls; it will not guess a credential.',
  )
  process.exit(2)
}

/**
 * The model to exercise, overridable.
 *
 * Named here rather than in `packages/llm` because that is the rule: a model
 * name lives in configuration, never in source (ADR-0015). A script under
 * `scripts/` is configuration by another name — this is not feature code, and
 * the boundary suite scopes itself to `apps/` and `packages/`.
 */
const MODEL: ModelRef = {
  provider: 'anthropic',
  model: process.env.CHORUS_SMOKE_MODEL?.trim() || 'claude-haiku-4-5',
}

const models = createProviderRegistry({
  anthropic: createAnthropicProvider({ apiKey: KEY }),
})

const CONTEXT = {
  workspaceId: 'smoke',
  teamId: 'smoke',
  purpose: 'chat' as const,
}

let failures = 0

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures += 1
}

/**
 * A long, stable prefix.
 *
 * Prompt caching has a minimum cacheable length, so a short system message
 * silently caches nothing and the check below would report a failure that is
 * really a test-design mistake.
 */
const STABLE_PREFIX = [
  'You are a careful assistant working inside a software delivery platform.',
  'Answer briefly and precisely.',
  ...Array.from(
    { length: 120 },
    (_, index) =>
      `Background note ${index}: this is stable context that does not change between calls, ` +
      'and exists so the cacheable prefix is long enough to be worth caching.',
  ),
].join('\n')

async function streaming(): Promise<void> {
  console.log('\n# streaming (NFR-2)')
  const started = Date.now()
  let text = ''
  let tokens = 0
  let firstTokenMs: number | undefined
  let usage: TokenUsage | undefined
  let error: string | undefined

  for await (const event of models.stream({
    model: MODEL,
    messages: [{ role: 'user', content: 'Name three colours, comma separated. No preamble.' }],
    context: CONTEXT,
  })) {
    if (event.type === 'token') {
      firstTokenMs ??= Date.now() - started
      tokens += 1
      text += event.text
    }
    if (event.type === 'done') usage = event.usage
    if (event.type === 'error') error = event.message
  }

  check('no error', error === undefined, error ?? '')
  check('text came back', text.trim().length > 0, JSON.stringify(text.slice(0, 60)))
  // More than one token event, or the provider buffered the reply and streaming
  // is decorative — which every cassette in the suite would still pass.
  check('it actually streamed', tokens > 1, `${tokens} token events`)
  check('first token was prompt', (firstTokenMs ?? 99_999) < 5_000, `${firstTokenMs}ms`)
  // The one the cassettes cannot prove: output tokens arrive in `message_delta`,
  // a frame after the last content delta. A provider reading usage from one
  // frame reports half the cost of every call, confidently.
  check(
    'usage carries BOTH input and output tokens',
    (usage?.inputTokens ?? 0) > 0 && (usage?.outputTokens ?? 0) > 0,
    JSON.stringify(usage),
  )
}

async function structured(): Promise<void> {
  console.log('\n# structured output (NFR-2, #162)')
  const schema = z.object({
    title: z.string().min(1),
    tags: z.array(z.string()),
  })

  try {
    const result = await models.generate({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: 'Give a title and two tags for a task about splitting an invoice parser.',
        },
      ],
      context: CONTEXT,
      schema,
      schemaName: 'smoke_draft',
    })

    check('schema was honoured', typeof result.value.title === 'string', JSON.stringify(result.value))
    check('usage reported', result.usage.inputTokens > 0, JSON.stringify(result.usage))
  } catch (error) {
    check('generate succeeded', false, error instanceof Error ? error.message : String(error))
  }
}

async function counting(): Promise<void> {
  console.log('\n# countTokens (NFR-8, #164)')
  try {
    const text = 'The invoice parser does three jobs and should do one.'
    const first = await models.countTokens(text, MODEL)
    const second = await models.countTokens(text, MODEL)

    check('a plausible count', first > 5 && first < 40, `${first} tokens`)
    check('the cache returns the same answer', first === second, `${first} then ${second}`)
  } catch (error) {
    check('countTokens succeeded', false, error instanceof Error ? error.message : String(error))
  }
}

async function caching(): Promise<void> {
  console.log('\n# prompt caching (NFR-8, #164)')

  async function once(): Promise<TokenUsage | undefined> {
    let usage: TokenUsage | undefined
    for await (const event of models.stream({
      model: MODEL,
      messages: [
        { role: 'system', content: STABLE_PREFIX },
        { role: 'user', content: 'Reply with the single word: ready.' },
      ],
      context: CONTEXT,
    })) {
      if (event.type === 'done') usage = event.usage
      if (event.type === 'error') console.error(`  stream error: ${event.message}`)
    }
    return usage
  }

  // The first call writes the cache; the second should read it. Anything else
  // means the breakpoint is in the wrong place or the prefix is not stable,
  // and neither shows up as an error — only as a bill.
  const first = await once()
  const second = await once()

  console.log(`  first:  ${JSON.stringify(first)}`)
  console.log(`  second: ${JSON.stringify(second)}`)
  check(
    'the second call read from cache',
    (second?.cachedInputTokens ?? 0) > 0,
    `cachedInputTokens=${second?.cachedInputTokens ?? 0}`,
  )
}

async function main(): Promise<void> {
  console.log(`Smoking ${MODEL.provider}/${MODEL.model} against the real API.`)
  await streaming()
  await structured()
  await counting()
  await caching()

  console.log(
    failures === 0
      ? '\nAll checks passed. The provider agrees with the endpoint.'
      : `\n${failures} check(s) failed — the code and the endpoint disagree.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()
