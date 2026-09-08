/**
 * A live smoke check of the model layer against real endpoints (NFR-2, NFR-8).
 *
 * Everything in `packages/llm` is proven against hand-written wire samples.
 * That is the right way to have built it — a test calling a real model is slow,
 * costly, and unfalsifiable, because a real model answers plausibly whatever
 * you send it, so a bug that sent the wrong context still produces a convincing
 * reply and a passing assertion.
 *
 * But a cassette proves the parser handles *the shape we wrote down*. It cannot
 * prove we wrote the shape down correctly. This is the other half: real calls,
 * reporting what actually came back.
 *
 * It runs through `providersFromEnv()` — the same construction the worker
 * uses — so it exercises the real wiring rather than a arrangement invented for
 * the script. Whichever providers the environment configures are the ones it
 * smokes:
 *
 *   CHORUS_ANTHROPIC_API_KEY=sk-ant-...      → the Anthropic provider
 *   CHORUS_MODEL_BASE_URL=https://...        → the OpenAI-compatible provider
 *   CHORUS_MODEL_API_KEY=...                   (its credential, where one is needed)
 *
 * Any OpenAI-compatible endpoint works, which is the point of that provider:
 * OpenRouter, a local Ollama, LM Studio, vLLM. Naming the model is the caller's
 * job there, because only they know what their endpoint serves:
 *
 *   CHORUS_SMOKE_ANTHROPIC_MODEL   (default: claude-haiku-4-5)
 *   CHORUS_SMOKE_OPENAI_MODEL      (no default — endpoints disagree)
 *
 * Deliberately **not** a test, and in no vitest project. CLAUDE.md §4: "Never
 * call a real model, a real tracker or a real network host from a test." A live
 * check in CI would be flaky, billable and dependent on somebody else's uptime.
 *
 *   pnpm smoke:models
 *
 * It spends a few cents and touches no database.
 */
import { z } from 'zod'
import { providersFromEnv, type ModelProvider, type ModelRef, type TokenUsage } from '@chorus/llm'

const CONTEXT = { workspaceId: 'smoke', teamId: 'smoke', purpose: 'chat' as const }

/**
 * A deliberately small output ceiling.
 *
 * Every question below wants a sentence, so a large ceiling would only make the
 * check expensive. It also keeps the script usable on a credit-limited account:
 * some gateways refuse a request whose *requested* ceiling exceeds the
 * remaining balance, regardless of what the reply would actually have cost.
 */
const SMOKE_MAX_OUTPUT_TOKENS = 512

let failures = 0
let checks = 0

function check(label: string, passed: boolean, detail = ''): void {
  checks += 1
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures += 1
}

function skip(label: string, why: string): void {
  console.log(`  skip  ${label} — ${why}`)
}

/**
 * A long, stable prefix.
 *
 * Prompt caching has a minimum cacheable length, so a short system message
 * silently caches nothing and the check would report a failure that is really a
 * mistake in the check.
 */
const STABLE_PREFIX = [
  'You are a careful assistant working inside a software delivery platform.',
  'Answer briefly and precisely.',
  ...Array.from(
    { length: 140 },
    (_, index) =>
      `Background note ${index}: stable context that does not change between calls, ` +
      'present so the cacheable prefix is long enough to be worth caching.',
  ),
].join('\n')

async function streaming(models: ModelProvider, model: ModelRef): Promise<void> {
  const started = Date.now()
  let text = ''
  let tokenEvents = 0
  let firstTokenMs: number | undefined
  let usage: TokenUsage | undefined
  let error: string | undefined

  for await (const event of models.stream({
    model,
    messages: [{ role: 'user', content: 'Name three colours, comma separated. No preamble.' }],
    context: CONTEXT,
    maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
  })) {
    if (event.type === 'token') {
      firstTokenMs ??= Date.now() - started
      tokenEvents += 1
      text += event.text
    }
    if (event.type === 'done') usage = event.usage
    if (event.type === 'error') error = event.message
  }

  check('stream: no error', error === undefined, error ?? '')
  check('stream: text came back', text.trim().length > 0, JSON.stringify(text.slice(0, 50)))
  // More than one token event, or the provider buffered the whole reply and
  // streaming is decorative — which every cassette in the suite would pass.
  check('stream: it actually streamed', tokenEvents > 1, `${tokenEvents} token events`)
  check('stream: first token was prompt', (firstTokenMs ?? 99_999) < 10_000, `${firstTokenMs}ms`)
  // The check the cassettes cannot make. On Anthropic the two counts arrive in
  // different frames, and a client reading one reports half the cost of every
  // call it makes — confidently, and visible only on the bill.
  check(
    'stream: usage carries BOTH token counts',
    (usage?.inputTokens ?? 0) > 0 && (usage?.outputTokens ?? 0) > 0,
    JSON.stringify(usage),
  )
}

async function structured(models: ModelProvider, model: ModelRef): Promise<void> {
  const schema = z.object({ title: z.string().min(1), tags: z.array(z.string()) })

  try {
    const result = await models.generate({
      model,
      messages: [
        {
          role: 'user',
          content: 'Give a title and two tags for a task about splitting an invoice parser.',
        },
      ],
      context: CONTEXT,
      schema,
      schemaName: 'smoke_draft',
      maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    })
    check('generate: the schema was honoured', typeof result.value.title === 'string',
      JSON.stringify(result.value))
    check('generate: usage reported', result.usage.inputTokens > 0, JSON.stringify(result.usage))
  } catch (error) {
    check('generate: succeeded', false, error instanceof Error ? error.message : String(error))
  }
}

async function toolCalling(models: ModelProvider, model: ModelRef): Promise<void> {
  const starts: string[] = []
  const deltas = new Map<string, string>()
  const ends: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  let error: string | undefined

  for await (const event of models.stream({
    model,
    messages: [
      {
        role: 'user',
        content: 'Read the file src/billing/parse.ts. Use the tool; do not answer in prose.',
      },
    ],
    context: CONTEXT,
    maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from the repository.',
        inputSchema: z.object({ path: z.string() }),
      },
    ],
  })) {
    if (event.type === 'tool_call_start') starts.push(event.id)
    if (event.type === 'tool_call_delta') {
      deltas.set(event.id, (deltas.get(event.id) ?? '') + event.argumentsDelta)
    }
    if (event.type === 'tool_call_end') ends.push(event)
    if (event.type === 'error') error = event.message
  }

  if (error) {
    check('tools: no error', false, error)
    return
  }
  if (ends.length === 0) {
    // Not a provider bug: a model may decline to call a tool. Reported as a
    // skip so a genuine parsing failure is not hidden inside a pass.
    skip('tools: the model made a call', 'the model answered without using the tool')
    return
  }

  const call = ends[0]!
  check('tools: the call was announced before its arguments', starts.includes(call.id), call.id)
  check('tools: arguments parse', typeof call.arguments.path === 'string',
    JSON.stringify(call.arguments))
  // The fragments must concatenate to what the completed call reports, or a
  // consumer rendering progress and one acting on the result disagree.
  const joined = deltas.get(call.id)
  if (joined === undefined) {
    skip('tools: deltas concatenate to the final arguments', 'the endpoint sent no fragments')
  } else {
    let matches = false
    try {
      matches = JSON.stringify(JSON.parse(joined)) === JSON.stringify(call.arguments)
    } catch {
      matches = false
    }
    check('tools: deltas concatenate to the final arguments', matches, joined.slice(0, 80))
  }
}

async function counting(models: ModelProvider, model: ModelRef): Promise<void> {
  try {
    const text = 'The invoice parser does three jobs and should do one.'
    const first = await models.countTokens(text, model)
    const second = await models.countTokens(text, model)
    check('countTokens: a plausible count', first > 4 && first < 40, `${first} tokens`)
    check('countTokens: the cache agrees', first === second, `${first} then ${second}`)
  } catch (error) {
    check('countTokens: succeeded', false, error instanceof Error ? error.message : String(error))
  }
}

async function caching(
  models: ModelProvider,
  model: ModelRef,
  explicitBreakpoint: boolean,
): Promise<void> {
  async function once(): Promise<TokenUsage | undefined> {
    let usage: TokenUsage | undefined
    for await (const event of models.stream({
      model,
      messages: [
        { role: 'system', content: STABLE_PREFIX },
        { role: 'user', content: 'Reply with the single word: ready.' },
      ],
      context: CONTEXT,
      maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    })) {
      if (event.type === 'done') usage = event.usage
      if (event.type === 'error') console.error(`    stream error: ${event.message}`)
    }
    return usage
  }

  // The first call writes the cache, the second should read it. Anything else
  // means the breakpoint is misplaced or the prefix is not stable — neither of
  // which raises an error. It shows up as a bill.
  const first = await once()
  const second = await once()
  console.log(`    first:  ${JSON.stringify(first)}`)
  console.log(`    second: ${JSON.stringify(second)}`)
  const hit = (second?.cachedInputTokens ?? 0) > 0
  if (explicitBreakpoint) {
    // The Anthropic provider places a cache breakpoint itself, so a miss is a
    // bug in where it put it — misplaced, it caches nothing and still pays for
    // the write, and nothing raises an error. It shows up as a bill.
    check('caching: the second call read from cache', hit, `cachedInputTokens=${second?.cachedInputTokens ?? 0}`)
  } else if (hit) {
    check('caching: cache reads are counted apart from fresh input', true,
      `cachedInputTokens=${second?.cachedInputTokens ?? 0}, inputTokens=${second?.inputTokens ?? 0}`)
  } else {
    // Automatic caching is the endpoint's decision, not ours. A miss here says
    // the endpoint chose not to cache, which is not a defect in this code.
    skip('caching', 'the endpoint reported no cache hit; it caches automatically or not at all')
  }
}

async function smoke(models: ModelProvider, model: ModelRef, cacheable: boolean): Promise<void> {
  console.log(`\n## ${model.provider} / ${model.model}`)
  await streaming(models, model)
  await structured(models, model)
  await toolCalling(models, model)
  await counting(models, model)
  await caching(models, model, cacheable)
}

async function main(): Promise<void> {
  let models: ModelProvider
  try {
    models = providersFromEnv()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }

  console.log(`Smoking through ${models.name}.`)

  if (process.env.CHORUS_ANTHROPIC_API_KEY?.trim()) {
    await smoke(
      models,
      {
        provider: 'anthropic',
        model: process.env.CHORUS_SMOKE_ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5',
      },
      true,
    )
  }

  if (process.env.CHORUS_MODEL_BASE_URL?.trim()) {
    const named = process.env.CHORUS_SMOKE_OPENAI_MODEL?.trim()
    if (!named) {
      console.error(
        '\nCHORUS_MODEL_BASE_URL is set but CHORUS_SMOKE_OPENAI_MODEL is not.\n' +
          'Endpoints disagree about model names, so this script will not guess one.',
      )
      process.exit(2)
    }
    await smoke(models, { provider: 'openai-compatible', model: named }, false)
  }

  console.log(
    failures === 0
      ? `\n${checks} checks passed. The providers agree with their endpoints.`
      : `\n${failures} of ${checks} checks FAILED — the code and the endpoint disagree.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()
