import { ValidationError } from '@chorus/core'

/**
 * INT-8 AC4 — Jira issue hierarchy, detected rather than assumed.
 *
 * Jira links a child issue to its parent in one of two ways, decided by the
 * project's type: a company-managed ("classic") project links a story to its
 * epic through the Epic Link custom field, while a team-managed ("next-gen")
 * project links every level through the built-in `parent` field. The field id
 * for Epic Link also varies per instance. Pushing a task tree with the wrong
 * scheme silently fails to build the hierarchy, so it is read from the project
 * at connect time and stored on the integration, and the push obeys it.
 */

/** How a Jira project links a child issue to its parent. */
export type HierarchyScheme = 'epic_link' | 'parent'

export interface HierarchyConfig {
  readonly scheme: HierarchyScheme
  /** The Epic Link custom field id, present for a company-managed project. */
  readonly epicLinkFieldId?: string
}

interface JiraField {
  readonly id?: string
  readonly name?: string
}

/**
 * The scheme a project uses, from its style and the instance's field list.
 *
 * `next-gen` is team-managed and always links through `parent`. Anything else
 * is treated as company-managed and links a story to its epic through the Epic
 * Link field, whose id is found by name because it is a custom field with a
 * per-instance id.
 */
export function detectHierarchyScheme(
  projectStyle: string | undefined,
  fields: readonly JiraField[],
): HierarchyConfig {
  if (projectStyle === 'next-gen') return { scheme: 'parent' }
  const epicLink = fields.find((field) => (field.name ?? '').toLowerCase() === 'epic link')
  return { scheme: 'epic_link', ...(epicLink?.id ? { epicLinkFieldId: epicLink.id } : {}) }
}

/**
 * The fields fragment that links a new issue to its parent under this scheme.
 *
 * `parentIsEpic` chooses the epic-link path on a company-managed project; a
 * subtask, or any child on a team-managed project, always uses `parent`. An
 * epic link with no Epic Link field is blocked rather than guessed — there is
 * no field to write, and writing `parent` instead would build the wrong tree.
 */
export function hierarchyFields(
  config: HierarchyConfig,
  parentKey: string,
  parentIsEpic: boolean,
): Record<string, unknown> {
  if (config.scheme === 'epic_link' && parentIsEpic) {
    if (!config.epicLinkFieldId) {
      throw new ValidationError(
        'This company-managed project has no Epic Link field, so a story cannot be linked to its epic.',
        { parentKey },
      )
    }
    return { [config.epicLinkFieldId]: parentKey }
  }
  return { parent: { key: parentKey } }
}
