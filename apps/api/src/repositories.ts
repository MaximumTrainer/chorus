import { ConflictError, NotFoundError, ValidationError, ulid } from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Repositories linked to a team (WS-3, architecture.md §8.2).
 *
 * A repository is team-scoped; the integration that holds its credential is
 * workspace-scoped. Linking therefore never introduces a credential — it can
 * only point at one the workspace has already connected, which is what stops a
 * team acquiring access nobody granted above it.
 */

export const REPOSITORY_PROVIDERS = ['github', 'gitlab'] as const
export type RepositoryProvider = (typeof REPOSITORY_PROVIDERS)[number]

export interface RepositoryRecord {
  readonly id: string
  readonly teamId: string
  readonly integrationId: string
  readonly provider: RepositoryProvider
  readonly fullName: string
  readonly defaultBranch: string
  readonly baseBranch: string
  readonly settings: Readonly<Record<string, unknown>>
}

export interface RepositoryService {
  link(input: {
    workspaceId: string
    teamId: string
    actorId: string
    integrationId: string
    provider: string
    fullName: string
    defaultBranch?: string
    baseBranch?: string
  }): Promise<RepositoryRecord>
  listForTeam(workspaceId: string, teamId: string): Promise<RepositoryRecord[]>
  unlink(workspaceId: string, teamId: string, actorId: string, repositoryId: string): Promise<void>
}

interface RepositoryRow {
  id: string
  team_id: string
  integration_id: string
  provider: RepositoryProvider
  full_name: string
  default_branch: string
  base_branch: string
  settings: Record<string, unknown>
}

const recordOf = (row: RepositoryRow): RepositoryRecord => ({
  id: row.id,
  teamId: row.team_id,
  integrationId: row.integration_id,
  provider: row.provider,
  fullName: row.full_name,
  defaultBranch: row.default_branch,
  baseBranch: row.base_branch,
  settings: row.settings,
})

/** `owner/name`, which is what both providers use and what a clone URL needs. */
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/

export function createRepositoryService(config: DbConfig): RepositoryService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  return {
    async link(input) {
      if (!(REPOSITORY_PROVIDERS as readonly string[]).includes(input.provider)) {
        throw new ValidationError(
          `Provider must be one of: ${REPOSITORY_PROVIDERS.join(', ')}`,
          { field: 'provider', allowed: REPOSITORY_PROVIDERS },
        )
      }
      if (!FULL_NAME.test(input.fullName)) {
        throw new ValidationError('A repository is named "owner/name"', { field: 'fullName' })
      }

      const id = ulid()
      const defaultBranch = input.defaultBranch?.trim() || 'main'
      // Defaults to the default branch rather than to `main`: a team on
      // `develop` that never set this would otherwise have its agents branch
      // off a trunk it does not use.
      const baseBranch = input.baseBranch?.trim() || defaultBranch

      return tx(
        input.workspaceId,
        async (t) => {
          // Both checks are scoped by the tenant context, so an id from another
          // workspace is simply not there — the same answer as one that never
          // existed, which is what WS-2 AC4 requires.
          const [team] = await t.query<{ id: string }>(
            `SELECT id FROM teams WHERE id = $1 AND deleted_at IS NULL`,
            [input.teamId],
          )
          if (!team) throw new NotFoundError('No such team', { teamId: input.teamId })

          const [integration] = await t.query<{ id: string }>(
            `SELECT id FROM integrations WHERE id = $1 AND deleted_at IS NULL`,
            [input.integrationId],
          )
          if (!integration) {
            throw new NotFoundError('No such integration', { integrationId: input.integrationId })
          }

          return mutate(t, {
            workspaceId: input.workspaceId,
            actor: { type: 'user', id: input.actorId },
            action: 'repository.link',
            targetType: 'repository',
            targetId: id,
            after: {
              teamId: input.teamId,
              provider: input.provider,
              fullName: input.fullName,
              defaultBranch,
              baseBranch,
            },
            apply: async () => {
              try {
                await t.execute(
                  `INSERT INTO repositories
                     (id, workspace_id, team_id, integration_id, provider, full_name,
                      default_branch, base_branch)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                  [
                    id,
                    input.workspaceId,
                    input.teamId,
                    input.integrationId,
                    input.provider,
                    input.fullName,
                    defaultBranch,
                    baseBranch,
                  ],
                )
              } catch (error) {
                // The index is what holds the line under concurrency; a
                // read-then-write would let two simultaneous links both pass.
                if (String(error).includes('repositories_unique')) {
                  throw new ConflictError('That repository is already linked to this team', {
                    fullName: input.fullName,
                  })
                }
                throw error
              }

              return {
                id,
                teamId: input.teamId,
                integrationId: input.integrationId,
                provider: input.provider as RepositoryProvider,
                fullName: input.fullName,
                defaultBranch,
                baseBranch,
                settings: {},
              }
            },
          })
        },
        input.actorId,
      )
    },

    async listForTeam(workspaceId, teamId) {
      const rows = await tx(workspaceId, (t) =>
        t.query<RepositoryRow>(
          `SELECT id, team_id, integration_id, provider, full_name, default_branch,
                  base_branch, settings
             FROM repositories
            WHERE team_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC`,
          [teamId],
        ),
      )
      return rows.map(recordOf)
    },

    async unlink(workspaceId, teamId, actorId, repositoryId) {
      await tx(
        workspaceId,
        async (t) => {
          const [existing] = await t.query<RepositoryRow>(
            `SELECT id, team_id, integration_id, provider, full_name, default_branch,
                    base_branch, settings
               FROM repositories
              WHERE id = $1 AND team_id = $2 AND deleted_at IS NULL`,
            [repositoryId, teamId],
          )
          if (!existing) throw new NotFoundError('No such repository', { repositoryId })

          await mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'repository.unlink',
            targetType: 'repository',
            targetId: repositoryId,
            before: { fullName: existing.full_name, teamId },
            after: { unlinked: true },
            // Soft-deleted rather than removed: the index built from it and the
            // signals attributed to it outlive the link, and a hard delete
            // would orphan both.
            apply: () =>
              t.execute(
                `UPDATE repositories SET deleted_at = now(), updated_at = now() WHERE id = $1`,
                [repositoryId],
              ),
          })
        },
        actorId,
      )
    },
  }
}
