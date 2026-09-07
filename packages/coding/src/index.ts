export { assembleBrief, DEFAULT_BUDGET_CHARS } from './brief.js'
export type {
  Brief,
  BriefJson,
  BriefInputs,
  BriefConventions,
  BriefDocument,
  BriefDecision,
  BriefCapture,
  BriefPointer,
  BriefTask,
} from './brief.js'
export { createBriefBuilder } from './brief-builder.js'
export type { BriefBuilder } from './brief-builder.js'
export { BRIEF_FILENAME, BRIEF_JSON_FILENAME } from './adapter.js'
export type {
  CodingAdapter,
  JobContext,
  JobEvent,
  JobResult,
  PreparedJob,
} from './adapter.js'
export { createReferenceAdapter } from './adapters/reference.js'
export type { ReferenceAdapterOptions } from './adapters/reference.js'
export { createClaudeCodeAdapter } from './adapters/claude-code.js'
export type { ClaudeCodeAdapterOptions } from './adapters/claude-code.js'
