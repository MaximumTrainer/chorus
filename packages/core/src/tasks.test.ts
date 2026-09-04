import { describe, it, expect } from 'vitest'
import {
  CreateTaskSchema,
  MAX_TASK_DEPTH,
  RESERVED_TASK_TAGS,
  UpdateTaskSchema,
  isChildDisposition,
  isReservedTaskTag,
  normaliseTags,
} from './tasks.js'

/**
 * TASK-1 — schema validation, tag normalisation and the reserved `Agent` tag.
 *
 * The tag rules carry more weight than they look. `Agent` is not a label: it
 * makes a task eligible for automatic launch (TASK-5), so a tag that *triggers*
 * behaviour must not be reachable by a near-miss and must not be missed by one
 * either. Both directions are tested.
 */
describe('TASK-1 task schema', () => {
  it('TASK-1: a reserved tag is recognised however it was typed', () => {
    // Somebody typing `agent` in a hurry means the reserved tag. A comparison
    // that missed it would silently produce a task that never launches, with
    // no error and a tag that looks right in the UI.
    expect(normaliseTags(['agent'])).toEqual(['Agent'])
    expect(normaliseTags(['AGENT'])).toEqual(['Agent'])
    expect(normaliseTags(['  Agent  '])).toEqual(['Agent'])
    expect(normaliseTags(['cOdInG'])).toEqual(['Coding'])
  })

  it('TASK-1: a near-miss is not the reserved tag, and stays the team’s own', () => {
    // `agents` is not `Agent`. Treating it as one would launch work nobody
    // asked to be launched, which is the more expensive direction of this
    // mistake.
    expect(normaliseTags(['agents'])).toEqual(['agents'])
    expect(normaliseTags(['agent-review'])).toEqual(['agent-review'])
  })

  it('TASK-1: custom tags keep the casing the team gave them', () => {
    // Lower-casing everything would turn "OKR" into "okr" in every view. They
    // are the team's words, not ours.
    expect(normaliseTags(['OKR', 'Q3 Push'])).toEqual(['OKR', 'Q3 Push'])
  })

  it('TASK-1: duplicates collapse after normalisation, not before', () => {
    // `coding` and `Coding` are one tag. Collapsing before normalising would
    // keep both and render a duplicate.
    expect(normaliseTags(['coding', 'Coding', 'CODING'])).toEqual(['Coding'])
    expect(normaliseTags(['OKR', 'okr'])).toEqual(['OKR'])
  })

  it('TASK-1: empty and whitespace-only tags are dropped rather than stored', () => {
    expect(normaliseTags(['', '   ', 'Coding'])).toEqual(['Coding'])
  })

  it('TASK-1: every reserved tag round-trips as itself', () => {
    // Guards the list against an entry that normalises to something else —
    // which would make that tag unusable while looking present.
    for (const tag of RESERVED_TASK_TAGS) {
      expect(normaliseTags([tag])).toEqual([tag])
      expect(isReservedTaskTag(tag)).toBe(true)
    }
  })

  it('TASK-1 AC5: a criterion may be created without an id and defaults to unchecked', () => {
    // A caller creating a task should not have to invent ids; a caller
    // updating one must be able to address what is already there.
    const task = CreateTaskSchema.parse({
      title: 'Split the parser',
      acceptanceCriteria: [{ text: 'Each line parses' }],
    })

    expect(task.acceptanceCriteria[0]).toMatchObject({ text: 'Each line parses', checked: false })
    expect(task.acceptanceCriteria[0]!.id).toBeUndefined()
  })

  it('TASK-1: a task must have a title, and a blank one is not a title', () => {
    expect(() => CreateTaskSchema.parse({ title: '' })).toThrow()
    expect(() => CreateTaskSchema.parse({ title: '    ' })).toThrow()
    expect(CreateTaskSchema.parse({ title: '  Trimmed  ' }).title).toBe('Trimmed')
  })

  it('TASK-1: an unestimated task has no size, rather than a size nobody chose', () => {
    const task = CreateTaskSchema.parse({ title: 'x' })
    expect(task.size).toBeUndefined()
    expect(() => CreateTaskSchema.parse({ title: 'x', size: 'Medium' })).toThrow()
  })

  it('TASK-1 AC3: `null` and absent mean different things for a parent', () => {
    // Absent leaves the parent alone; `null` moves the task to the root.
    // Collapsing them would make it impossible to un-parent anything.
    expect('parentId' in UpdateTaskSchema.parse({})).toBe(false)
    expect(UpdateTaskSchema.parse({ parentId: null }).parentId).toBeNull()
  })

  it('TASK-1 AC4: a child disposition must be one of the two real choices', () => {
    // The point of AC4 is that the caller *chooses*. An unrecognised value must
    // not fall through to a default, because either default loses something.
    expect(isChildDisposition('cascade')).toBe(true)
    expect(isChildDisposition('reparent')).toBe(true)
    expect(isChildDisposition('orphan')).toBe(false)
    expect(isChildDisposition(undefined)).toBe(false)
  })

  it('TASK-1 AC3: the depth limit is a small number a person can hold in mind', () => {
    // A tree deep enough to need scrolling to understand is a tree nobody
    // reads. The number matters less than its being bounded and stated.
    expect(MAX_TASK_DEPTH).toBeGreaterThan(1)
    expect(MAX_TASK_DEPTH).toBeLessThan(10)
  })
})
