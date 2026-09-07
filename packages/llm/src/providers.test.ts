import { describe, it, expect } from 'vitest'
import { ConfigurationError } from '@chorus/core'
import { providersFromEnv } from './providers.js'

/**
 * NFR-2 — building the registry a deployment actually configured.
 *
 * The tier configuration names providers (`{"provider": "anthropic", ...}`),
 * and until something turned those names into clients the naming was a
 * formality. This is the seam where an operator's environment becomes the set
 * of providers the system can reach, so its failure messages are the ones an
 * operator reads at three in the morning: they name the variable to set.
 */
describe('NFR-2 providers from the environment', () => {
  it('NFR-2: builds an OpenAI-compatible provider when a base URL is configured', () => {
    const registry = providersFromEnv({ CHORUS_MODEL_BASE_URL: 'https://models.invalid/v1' })

    expect(registry.name).toContain('openai-compatible')
    expect(registry.name).not.toContain('anthropic')
  })

  it('NFR-2: builds an Anthropic provider when a key is configured', () => {
    const registry = providersFromEnv({ CHORUS_ANTHROPIC_API_KEY: 'sk-ant-test' })

    expect(registry.name).toContain('anthropic')
    expect(registry.name).not.toContain('openai-compatible')
  })

  it('NFR-2: builds both when both are configured, so a tier may name either', () => {
    const registry = providersFromEnv({
      CHORUS_MODEL_BASE_URL: 'https://models.invalid/v1',
      CHORUS_ANTHROPIC_API_KEY: 'sk-ant-test',
    })

    expect(registry.name).toContain('anthropic')
    expect(registry.name).toContain('openai-compatible')
  })

  it('NFR-2: with nothing configured it refuses, naming both variables', () => {
    // The message is the whole diagnosis. An operator who has set neither needs
    // to be told which two settings exist, not that configuration is invalid.
    let thrown: unknown
    try {
      providersFromEnv({})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConfigurationError)
    expect((thrown as Error).message).toContain('CHORUS_MODEL_BASE_URL')
    expect((thrown as Error).message).toContain('CHORUS_ANTHROPIC_API_KEY')
  })

  it('NFR-2: a self-hosted endpoint needs no credential', () => {
    // Ollama and LM Studio take none. Requiring one here would make NFR-1's
    // "no mandatory SaaS dependency" false for exactly the deployment it is
    // meant to protect.
    expect(() => providersFromEnv({ CHORUS_MODEL_BASE_URL: 'http://localhost:11434/v1' })).not.toThrow()
  })
})
