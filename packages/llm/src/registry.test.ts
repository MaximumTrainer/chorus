import { describe, it, expect } from 'vitest'
import { ConfigurationError } from '@chorus/core'
import { createProviderRegistry } from './registry.js'
import type { ChatRequest, ModelProvider, StreamEvent } from './provider.js'
import type { ModelRef } from './types.js'

/**
 * NFR-2 — the registry that makes `ref.provider` load-bearing.
 *
 * The router already resolves a purpose to a tier and a tier to a concrete
 * `{provider, model}`. Until this existed, the `provider` half of that answer
 * was decorative: one client served every call, and the ledger recorded a name
 * nothing had acted on. A workspace could name Anthropic in its configuration
 * and be served by whatever endpoint happened to be wired in.
 *
 * The registry is itself a `ModelProvider`, so nothing downstream — the turn
 * runner, the executor — learns that there is more than one.
 */

const CONTEXT = {
  workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  teamId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  purpose: 'chat',
} as const

function labelled(name: string): ModelProvider {
  return {
    name,
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: 'token', text: `served by ${name}` }
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async embed(texts: readonly string[]): Promise<number[][]> {
      return texts.map(() => [name.length])
    },
  }
}

function request(ref: ModelRef): ChatRequest {
  return { model: ref, messages: [{ role: 'user', content: 'hello' }], context: CONTEXT }
}

async function textOf(provider: ModelProvider, ref: ModelRef): Promise<string> {
  let text = ''
  for await (const event of provider.stream(request(ref))) {
    if (event.type === 'token') text += event.text
  }
  return text
}

describe('NFR-2 provider registry', () => {
  it('NFR-2: streams from the provider the model reference names', async () => {
    const registry = createProviderRegistry({
      anthropic: labelled('anthropic'),
      'openai-compatible': labelled('openai-compatible'),
    })

    expect(await textOf(registry, { provider: 'anthropic', model: 'a-1' })).toBe(
      'served by anthropic',
    )
    expect(await textOf(registry, { provider: 'openai-compatible', model: 'o-1' })).toBe(
      'served by openai-compatible',
    )
  })

  it('NFR-2: embeds through the provider the model reference names', async () => {
    const registry = createProviderRegistry({
      'openai-compatible': labelled('openai-compatible'),
      other: labelled('other'),
    })

    expect(await registry.embed(['text'], { provider: 'other', model: 'e-1' })).toEqual([[5]])
  })

  it('NFR-2: an unconfigured provider fails, naming it and what is configured', async () => {
    const registry = createProviderRegistry({ 'openai-compatible': labelled('openai-compatible') })

    // Refused rather than served by whichever client is at hand. A call
    // silently answered by the wrong provider is billed to the wrong ledger
    // line and reasoned about with the wrong capabilities — the invisible
    // downgrade the router's fallback recording exists to prevent.
    const events: StreamEvent[] = []
    for await (const event of registry.stream(request({ provider: 'anthropic', model: 'a-1' }))) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('anthropic')
    expect((events[0] as { message: string }).message).toContain('openai-compatible')
  })

  it('NFR-2: an unconfigured provider fails on embed too, rather than returning nothing', async () => {
    const registry = createProviderRegistry({ 'openai-compatible': labelled('openai-compatible') })

    await expect(
      registry.embed(['text'], { provider: 'anthropic', model: 'a-1' }),
    ).rejects.toBeInstanceOf(ConfigurationError)
  })

  it('NFR-2: a registry with no providers is refused when it is built, not when a run needs one', () => {
    // Boot is the cheapest moment to find this. A registry that accepts an
    // empty map defers the failure to the first model call, which is the middle
    // of somebody's turn.
    expect(() => createProviderRegistry({})).toThrow(ConfigurationError)
  })

  it('NFR-2: it reports the providers it can reach, for a health page', () => {
    const registry = createProviderRegistry({
      anthropic: labelled('anthropic'),
      'openai-compatible': labelled('openai-compatible'),
    })

    expect(registry.name).toContain('anthropic')
    expect(registry.name).toContain('openai-compatible')
  })
})
