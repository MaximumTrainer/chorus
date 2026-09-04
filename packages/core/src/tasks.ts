import { z } from 'zod'

/**
 * The task (TASK-1, architecture.md §8.2).
 *
 * > The task is the contract between shaping and delivery, and it is consumed
 * > by a machine as often as by a person.
 *
 * Everything unusual in this file follows from the second half. Acceptance
 * criteria are structured rather than prose because a pull request renders
 * them as a checklist and a coding agent satisfies them one at a time; each
 * carries a stable id because an external system that checked one off must
 * still be pointing at the same criterion after somebody reorders the list.
 */

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const TASK_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const
export type TaskSize = (typeof TASK_SIZES)[number]

/**
 * Tags with meaning attached, as opposed to the team's own words.
 *
 * `Agent` is the one that does something: it is what makes a task eligible for
 * automatic launch (TASK-5). A tag that *triggers* behaviour must not be
 * reachable by accident, which is why these are normalised to canonical casing
 * rather than compared loosely at each use site — `agent`, `AGENT` and `Agent`
 * are one tag, and a team's custom `agents` is not.
 */
export const RESERVED_TASK_TAGS = [
  'Coding',
  'Design',
  'Research',
  'Documentation',
  'Testing',
  'Agent',
] as const
export type ReservedTaskTag = (typeof RESERVED_TASK_TAGS)[number]

/** Longest ancestry a task may have (AC3). */
export const MAX_TASK_DEPTH = 5

/**
 * Canonicalises reserved tags and leaves custom ones alone.
 *
 * Custom tags are kept exactly as written, because they are the team's words
 * and not ours — lower-casing them would turn "OKR" into "okr" in every view.
 * Duplicates are collapsed after normalisation, so `coding` and `Coding` do
 * not both survive.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of tags) {
    const trimmed = raw.trim()
    if (trimmed === '') continue

    const reserved = RESERVED_TASK_TAGS.find(
      (tag) => tag.toLowerCase() === trimmed.toLowerCase(),
    )
    const value = reserved ?? trimmed
    if (seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    result.push(value)
  }

  return result
}

export function isReservedTaskTag(tag: string): boolean {
  return RESERVED_TASK_TAGS.some((reserved) => reserved === tag)
}

/**
 * One acceptance criterion.
 *
 * `id` is optional on input and always present on output: a caller creating a
 * task should not have to invent ids, but a caller updating one must be able
 * to address what is already there.
 */
export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string().min(1).max(2000),
  checked: z.boolean().default(false),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const StoredAcceptanceCriterionSchema = AcceptanceCriterionSchema.extend({
  id: z.string().min(1),
})
export type StoredAcceptanceCriterion = z.infer<typeof StoredAcceptanceCriterionSchema>

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  /** The editor's document model, not HTML: markup cannot be diffed usefully. */
  description: z.record(z.string(), z.unknown()).default({}),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(100).default([]),
  tags: z.array(z.string().max(100)).max(50).default([]),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  /** Absent means unestimated, which is an ordinary state rather than a zero. */
  size: z.enum(TASK_SIZES).optional(),
  assigneeId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
})
export type CreateTask = z.infer<typeof CreateTaskSchema>

/**
 * Every field optional, and `parentId` nullable.
 *
 * `null` and absent mean different things here: absent leaves the parent alone,
 * `null` moves the task to the root. Collapsing them would make it impossible
 * to un-parent anything.
 */
export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.record(z.string(), z.unknown()).optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(100).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  size: z.enum(TASK_SIZES).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().finite().optional(),
})
export type UpdateTask = z.infer<typeof UpdateTaskSchema>

export interface TaskRecord {
  readonly id: string
  readonly key: string
  readonly teamId: string
  readonly parentId: string | null
  readonly title: string
  readonly description: Record<string, unknown>
  readonly acceptanceCriteria: readonly StoredAcceptanceCriterion[]
  readonly tags: readonly string[]
  readonly status: TaskStatus
  readonly priority: TaskPriority
  readonly size: TaskSize | null
  readonly assigneeId: string | null
  readonly position: number
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** What happens to a parent's children when it is deleted (AC4). */
export const CHILD_DISPOSITIONS = ['cascade', 'reparent'] as const
export type ChildDisposition = (typeof CHILD_DISPOSITIONS)[number]

export function isChildDisposition(value: unknown): value is ChildDisposition {
  return typeof value === 'string' && (CHILD_DISPOSITIONS as readonly string[]).includes(value)
}
