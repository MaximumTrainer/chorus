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
export { evaluateLaunch, branchNameFor, LAUNCH_ROLE } from './launch.js'
export type { LaunchConditions, LaunchVerdict } from './launch.js'
export { pullRequestBody, pullRequestTitle } from './pull-request.js'
export type { PullRequestFacts } from './pull-request.js'
export { createCodingJobService, ACTIVE_STATUSES } from './jobs.js'
export type {
  CodingJob,
  CodingJobService,
  CodingJobStatus,
  CodingJobsConfig,
  LaunchRequest,
  LaunchOutcome,
  CompleteRequest,
} from './jobs.js'
