import { ConfigurationError } from '@chorus/core'
import type { ModelProvider } from './provider.js'
import { createProviderRegistry } from './registry.js'
import { createAnthropicProvider } from './providers/anthropic.js'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible.js'

/**
 * Turns an operator's environment into the set of providers this deployment can
 * reach (NFR-2).
 *
 * Tier configuration names providers — `{"provider": "anthropic", …}` — and
 * this is where those names become clients. Both are optional and at least one
 * is required: a deployment may run entirely on a local endpoint (NFR-1),
 * entirely on Anthropic, or on both with tiers pointed at whichever suits.
 *
 * Model names never appear here. They arrive through `CHORUS_MODEL_TIERS`,
 * which is what keeps a provider's deprecation an ops change rather than a
 * release (ADR-0015).
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const providers: Record<string, ModelProvider> = {}

  const baseUrl = env.CHORUS_MODEL_BASE_URL?.trim()
  if (baseUrl) {
    providers['openai-compatible'] = createOpenAiCompatibleProvider({
      baseUrl,
      // Absent for a local endpoint. Ollama and LM Studio take no credential,
      // and requiring one would make NFR-1's "no mandatory SaaS dependency"
      // false for exactly the deployment it exists to protect.
      ...(env.CHORUS_MODEL_API_KEY ? { apiKey: env.CHORUS_MODEL_API_KEY } : {}),
    })
  }

  const anthropicKey = env.CHORUS_ANTHROPIC_API_KEY?.trim()
  if (anthropicKey) {
    providers.anthropic = createAnthropicProvider({
      apiKey: anthropicKey,
      ...(env.CHORUS_ANTHROPIC_BASE_URL ? { baseUrl: env.CHORUS_ANTHROPIC_BASE_URL } : {}),
    })
  }

  if (Object.keys(providers).length === 0) {
    throw new ConfigurationError(
      'No model provider is configured. Set CHORUS_MODEL_BASE_URL for an ' +
        'OpenAI-compatible endpoint (including a local one), or ' +
        'CHORUS_ANTHROPIC_API_KEY for Anthropic, or both. ' +
        'See deploy/model-tiers.example.json.',
    )
  }

  return createProviderRegistry(providers)
}
