import { ConfigurationError } from '@chorus/core'
import type {
  ChatRequest,
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from './provider.js'
import type { ModelRef } from './types.js'

/**
 * Dispatches a call to the provider its model reference names (NFR-2).
 *
 * `architecture.md` §9.1 says the router resolves `purpose → tier → concrete
 * provider and model`. The router has always returned both halves of that
 * answer; until this existed, only the model half was acted on. One client
 * served every call, so a workspace could configure Anthropic and be answered
 * by whatever endpoint was wired in — while the ledger recorded the provider it
 * had asked for. Wrong in the one place nobody re-checks.
 *
 * The registry is itself a `ModelProvider`. That is deliberate: `deps.models`
 * stays one interface, so the executor, the turn runner and every future caller
 * remain unaware that there is more than one provider — which is the whole of
 * what NFR-2 promises.
 */
export function createProviderRegistry(
  providers: Readonly<Record<string, ModelProvider>>,
): ModelProvider {
  const configured = Object.keys(providers).sort()

  // Boot is the cheapest moment to find this. A registry that accepted an empty
  // map would defer the failure to the first model call, which is the middle of
  // somebody's turn.
  if (configured.length === 0) {
    throw new ConfigurationError(
      'No model providers are configured. At least one is required; ' +
        'see deploy/model-tiers.example.json.',
    )
  }

  function missing(ref: ModelRef): ConfigurationError {
    return new ConfigurationError(
      `No provider named "${ref.provider}" is configured, so "${ref.model}" cannot be reached. ` +
        `Configured providers: ${configured.join(', ')}.`,
      { provider: ref.provider, model: ref.model, configured },
    )
  }

  return {
    // Named for what it can reach, so a health page and a boot log say which
    // providers this deployment actually has rather than just "registry".
    name: `registry(${configured.join(', ')})`,

    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      const provider = providers[request.model.provider]
      if (!provider) {
        // An error event rather than a throw, matching what every provider does
        // with an upstream failure: a consumer iterating a stream should not
        // have to handle two failure shapes.
        yield { type: 'error', message: missing(request.model).message }
        return
      }

      yield* provider.stream(request)
    },

    async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const provider = providers[request.model.provider]
      // Thrown rather than yielded: `generate` is request/response, and a
      // caller holding a `GenerateResult` must be able to rely on its shape.
      if (!provider) throw missing(request.model)
      return provider.generate(request)
    },

    async countTokens(text: string, model: ModelRef): Promise<number> {
      const provider = providers[model.provider]
      if (!provider) throw missing(model)
      return provider.countTokens(text, model)
    },

    async embed(texts: readonly string[], model: ModelRef): Promise<number[][]> {
      const provider = providers[model.provider]
      if (!provider) throw missing(model)
      return provider.embed(texts, model)
    },
  }
}
