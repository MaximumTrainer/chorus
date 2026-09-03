import type { AnyTool } from '@chorus/core'
import { createFetchUrlTool } from './fetch-url.js'

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
  return [createFetchUrlTool({ allowedHosts: options.allowedHosts }) as unknown as AnyTool]
}
