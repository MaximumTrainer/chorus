import type { AnyTool } from '@chorus/core'
import { createFetchUrlTool } from './fetch-url.js'
import { createClarifyTool } from './clarify.js'
import { trackerSinkTools } from './sink.js'

/**
 * The tools this deployment ships.
 *
 * A **list**, built here, rather than a directory scan or a decorator that
 * registers on import. The NFR gate for AGENT-5 AC2 enumerates exactly this, so
 * whether a tool is gated has to be answerable by reading one file — and a tool
 * that registered itself by being imported would be gated or not depending on
 * import order.
 *
 * It grows as each capability lands. Artefact tools arrive with the task and
 * document models; connector sinks — the first `external` tools — arrive with
 * INT-4, which is when the enumeration gate stops being a mechanism test and
 * starts having subjects.
 */

export interface ShippedToolOptions {
  /** Hosts `fetch_url` may reach (AGENT-5 AC6). Empty refuses everything. */
  readonly allowedHosts: readonly string[]
}

export function shippedTools(options: ShippedToolOptions): readonly AnyTool[] {
  return [
    createFetchUrlTool({ allowedHosts: options.allowedHosts }) as unknown as AnyTool,
    // CHAT-4: the code half of bounded clarifying questions. No side effect and
    // no network, so it needs nothing from the options.
    createClarifyTool() as unknown as AnyTool,
    // INT-4: the first `external` tools. Each writes through the sink dispatcher
    // its context carries, and the AGENT-5 AC2 gate now has real subjects — a
    // sink tool cannot be shipped without passing before_external_write.
    ...trackerSinkTools(),
  ]
}
