import { z } from 'zod'
import { CHECKPOINT_KINDS, CHECKPOINT_MODES } from './policies.js'

/**
 * The workflow definition (AGENT-1, architecture.md §11.1).
 *
 * A Zod schema rather than a type, because AC1 requires a definition to be
 * *validated at load* and to fail at startup naming the workflow and the
 * problem — never at run time. A workflow that fails halfway through because
 * step four references a tool that does not exist has already done steps one to
 * three, and some of those may have written something.
 *
 * That is the whole argument for this file: every check here is one that would
 * otherwise be discovered by a user, mid-run, after side effects.
 */

/** architecture.md §11.1. */
export const STEP_TYPES = [
  'retrieve',
  'model',
  'tool',
  'branch',
  'loop',
  'checkpoint',
  'emit',
] as const

export type StepType = (typeof STEP_TYPES)[number]

/** The tiers a workflow may name. Never a model — that is deployment config. */
export const MODEL_TIERS = ['fast', 'balanced', 'strong'] as const

/**
 * A step id, referenced by later steps as `{{stepId.output}}`.
 *
 * Constrained so a reference is unambiguous: an id containing a dot or a brace
 * would make a template expression parse two ways.
 */
const StepId = z.string().regex(/^[a-z][a-z0-9_]*$/, {
  message: 'a step id must be lower_snake_case',
})

const RetrieveStep = z.object({
  id: StepId,
  type: z.literal('retrieve'),
  query: z.string().min(1),
  kinds: z.array(z.string()).default([]),
  /** Graph hops. Bounded because expansion is exponential in the hop count. */
  expand: z.number().int().min(0).max(2).default(0),
  limit: z.number().int().min(1).max(50).default(10),
})

const ModelStep = z.object({
  id: StepId,
  type: z.literal('model'),
  /** A path under `workflows/prompts/**`, checked to exist at load. */
  prompt: z.string().min(1),
  /** Named output schema, so a model's answer is validated rather than trusted. */
  schema: z.string().optional(),
})

const ToolStep = z.object({
  id: StepId,
  type: z.literal('tool'),
  tool: z.string().min(1),
  input: z.unknown().optional(),
})

const CheckpointStep = z.object({
  id: StepId,
  type: z.literal('checkpoint'),
  kind: z.enum(CHECKPOINT_KINDS),
})

const EmitStep = z.object({
  id: StepId,
  type: z.literal('emit'),
  artefact: z.string().min(1),
})

const BranchStep = z.object({
  id: StepId,
  type: z.literal('branch'),
  when: z.string().min(1),
  then: z.array(StepId).min(1),
  otherwise: z.array(StepId).default([]),
})

const LoopStep = z.object({
  id: StepId,
  type: z.literal('loop'),
  over: z.string().min(1),
  body: z.array(StepId).min(1),
  /** Bounded: a loop whose collection a model produced could otherwise not terminate. */
  maxIterations: z.number().int().min(1).max(100).default(20),
})

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  RetrieveStep,
  ModelStep,
  ToolStep,
  CheckpointStep,
  EmitStep,
  BranchStep,
  LoopStep,
])

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const WorkflowDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message: 'a workflow name must be lower-kebab-case',
  }),
  /** Immutable once published; editing publishes a new version (AC4). */
  version: z.number().int().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  outputs: z.array(z.string()).default([]),
  /**
   * The allow-list. Not a manifest of what the workflow happens to use — a
   * *ceiling* on what it may use, so a prompt-injected instruction cannot widen
   * it (AGENT-5 AC1).
   */
  tools: z.array(z.string()).default([]),
  /** A tier, never a model. No model name appears in a definition (AC5). */
  model: z.enum(MODEL_TIERS).default('balanced'),
  /**
   * Workflow-level checkpoint defaults; a team policy may override (AGENT-3).
   *
   * Each kind optional, and `strict` so an unknown kind is *rejected* rather
   * than stripped. A typo'd checkpoint name that is silently ignored is a gate
   * that does not gate, which is the one failure here worth being loud about.
   */
  checkpoints: z
    .object({
      before_create_artefacts: z.enum(CHECKPOINT_MODES).optional(),
      before_external_write: z.enum(CHECKPOINT_MODES).optional(),
      before_coding_job: z.enum(CHECKPOINT_MODES).optional(),
      before_spend_over: z.enum(CHECKPOINT_MODES).optional(),
    })
    .strict()
    .default({}),
  steps: z.array(WorkflowStepSchema).min(1),
})

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

/** A problem found at load, phrased for whoever has to fix the definition. */
export interface DefinitionProblem {
  readonly workflow: string
  readonly message: string
}

export interface ValidationEnvironment {
  /** Tool names the registry actually has. */
  readonly tools: readonly string[]
  /** Prompt paths that exist on disk. */
  readonly prompts: readonly string[]
  /** Named output schemas a model step may reference. */
  readonly schemas?: readonly string[]
}

/**
 * Checks a definition against the world it will run in.
 *
 * Separate from the schema because these are *referential* checks — a tool
 * exists, a prompt file is there, a step id resolves. The schema says the shape
 * is right; this says the references are real, and that is the half AC1 is
 * actually about.
 *
 * Returns every problem rather than the first: a workflow author fixing one
 * name at a time, with a restart between each, is the experience this exists to
 * prevent.
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  environment: ValidationEnvironment,
): DefinitionProblem[] {
  const problems: DefinitionProblem[] = []
  const say = (message: string): void => {
    problems.push({ workflow: `${definition.name}@${definition.version}`, message })
  }

  const stepIds = new Set<string>()
  for (const step of definition.steps) {
    if (stepIds.has(step.id)) {
      // Two steps with one id makes `{{id.output}}` ambiguous, and makes
      // resumption match the wrong step.
      say(`step id "${step.id}" is used more than once`)
    }
    stepIds.add(step.id)
  }

  const declaredTools = new Set(definition.tools)
  const available = new Set(environment.tools)
  const prompts = new Set(environment.prompts)
  const schemas = new Set(environment.schemas ?? [])

  for (const tool of definition.tools) {
    if (!available.has(tool)) {
      say(`allow-lists tool "${tool}", which is not registered`)
    }
  }

  for (const step of definition.steps) {
    switch (step.type) {
      case 'tool':
        if (!available.has(step.tool)) {
          say(`step "${step.id}" calls tool "${step.tool}", which is not registered`)
        } else if (!declaredTools.has(step.tool)) {
          // The allow-list is the ceiling. A step calling a tool the workflow
          // did not declare would be refused at run time — after earlier steps
          // had already run.
          say(`step "${step.id}" calls tool "${step.tool}", which is not in the allow-list`)
        }
        break

      case 'model':
        if (!prompts.has(step.prompt)) {
          say(`step "${step.id}" uses prompt "${step.prompt}", which does not exist`)
        }
        if (step.schema && schemas.size > 0 && !schemas.has(step.schema)) {
          say(`step "${step.id}" names output schema "${step.schema}", which is not defined`)
        }
        break

      case 'branch':
        for (const target of [...step.then, ...step.otherwise]) {
          if (!stepIds.has(target)) {
            say(`step "${step.id}" branches to "${target}", which is not a step`)
          }
        }
        break

      case 'loop':
        for (const target of step.body) {
          if (!stepIds.has(target)) {
            say(`step "${step.id}" loops over "${target}", which is not a step`)
          }
        }
        break

      default:
        break
    }
  }

  return problems
}
