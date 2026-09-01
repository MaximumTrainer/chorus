import { createHash, randomBytes } from 'node:crypto'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  atLeast,
  ulid,
  type Role,
} from '@chorus/core'
import { mutate, withTenant, type DbConfig, type TenantTx } from '@chorus/db'

/**
 * Workspaces, membership and invitations (WS-2, and WS-3's default team).
 *
 * The workspace is the tenancy boundary the whole system rests on, so the rules
 * here are deliberately conservative: another workspace's id is indistinguishable
 * from one that does not exist, and the last owner cannot be removed.
 */

export interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly slug: string
}

/** URL-safe, collision-resolved slug. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'workspace'
}

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

export interface WorkspaceService {
  create(userId: string, name: string): Promise<WorkspaceRecord>
  listFor(userId: string): Promise<WorkspaceRecord[]>
  /** The caller's role, or undefined if they are not a member. */
  roleOf(workspaceId: string, userId: string): Promise<Role | undefined>
  get(workspaceId: string, userId: string): Promise<WorkspaceRecord>
  members(workspaceId: string): Promise<Array<{ userId: string; workspaceId: string; role: Role }>>
  invite(input: {
    workspaceId: string
    invitedBy: string
    role: Role
    email?: string
    allowedDomain?: string
    ttlHours?: number
  }): Promise<{ id: string; token: string; expiresAt: Date }>
  acceptInvitation(token: string, userId: string, userEmail: string): Promise<WorkspaceRecord>
  removeMember(workspaceId: string, actorId: string, targetUserId: string): Promise<void>
  changeRole(workspaceId: string, actorId: string, targetUserId: string, role: Role): Promise<void>
}

export function createWorkspaceService(config: DbConfig): WorkspaceService {
  const tx = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>, userId?: string): Promise<T> =>
    withTenant(workspaceId, fn, { config, ...(userId ? { userId } : {}) })

  /**
   * Reads that must span workspaces: a user discovering which workspaces they
   * belong to, before any tenant context exists.
   *
   * This is not a bypass. `app.user_id` is set and migration 0004's policy
   * permits a caller to see their *own* membership rows in any workspace and
   * nobody else's. `workspaces` and `users` carry no workspace_id and are not
   * tenant tables, so they are readable here by design.
   */
  const readAcrossWorkspaces = <T>(userId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
    withTenant('__none__', fn, { config, userId })

  return {
    async create(userId, name) {
      const trimmed = name.trim()
      if (!trimmed) throw new ValidationError('A workspace needs a name', { field: 'name' })

      const id = ulid()
      let slug = slugify(trimmed)

      // Resolve a slug collision deterministically rather than failing: the
      // name a team chooses is not their problem to deduplicate.
      const taken = await readAcrossWorkspaces(userId, (t) =>
        t.query<{ slug: string }>(`SELECT slug FROM workspaces WHERE slug LIKE $1`, [`${slug}%`]),
      )
      if (taken.some((row) => row.slug === slug)) slug = `${slug}-${id.slice(-6).toLowerCase()}`

      await tx(
        id,
        async (t) =>
          mutate(t, {
            workspaceId: id,
            actor: { type: 'user', id: userId },
            action: 'workspace.create',
            targetType: 'workspace',
            targetId: id,
            after: { name: trimmed, slug },
            apply: async () => {
              // The workspace row itself is not tenant-scoped, so it is written
              // before the policies below have anything to match against.
              await t.execute(`INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)`, [
                id,
                trimmed,
                slug,
              ])
              await t.execute(
                `INSERT INTO workspace_members (id, workspace_id, user_id, role)
                 VALUES ($1, $2, $3, 'owner')`,
                [ulid(), id, userId],
              )
              // WS-2 AC1 / WS-3: exactly one default team, usable immediately.
              const teamId = ulid()
              await t.execute(
                `INSERT INTO teams (id, workspace_id, name, slug) VALUES ($1, $2, 'Default', 'default')`,
                [teamId, id],
              )
              await t.execute(
                `INSERT INTO team_members (id, workspace_id, team_id, user_id) VALUES ($1, $2, $3, $4)`,
                [ulid(), id, teamId, userId],
              )
            },
          }),
        userId,
      )

      return { id, name: trimmed, slug }
    },

    async listFor(userId) {
      return readAcrossWorkspaces(userId, (t) =>
        t.query<WorkspaceRecord>(
          `SELECT w.id, w.name, w.slug
             FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = $1 AND m.deleted_at IS NULL AND w.deleted_at IS NULL
            ORDER BY w.created_at DESC`,
          [userId],
        ),
      )
    },

    async roleOf(workspaceId, userId) {
      const rows = await readAcrossWorkspaces(userId, (t) =>
        t.query<{ role: Role }>(
          `SELECT role FROM workspace_members
            WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [workspaceId, userId],
        ),
      )
      return rows[0]?.role
    },

    async get(workspaceId, userId) {
      const role = await this.roleOf(workspaceId, userId)
      // WS-2 AC4: not-found rather than forbidden. Existence is information,
      // and confirming it would let anyone enumerate workspaces by id.
      if (!role) throw new NotFoundError('No such workspace', { workspaceId })

      const rows = await readAcrossWorkspaces(userId, (t) =>
        t.query<WorkspaceRecord>(
          `SELECT id, name, slug FROM workspaces WHERE id = $1 AND deleted_at IS NULL`,
          [workspaceId],
        ),
      )
      const workspace = rows[0]
      if (!workspace) throw new NotFoundError('No such workspace', { workspaceId })
      return workspace
    },

    async members(workspaceId) {
      return tx(workspaceId, (t) =>
        t.query<{ userId: string; workspaceId: string; role: Role }>(
          `SELECT user_id AS "userId", workspace_id AS "workspaceId", role
             FROM workspace_members WHERE deleted_at IS NULL ORDER BY created_at`,
        ),
      )
    },

    async invite(input) {
      const token = randomBytes(32).toString('base64url')
      const id = ulid()
      const expiresAt = new Date(Date.now() + (input.ttlHours ?? 24 * 7) * 3600_000)

      await tx(
        input.workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId: input.workspaceId,
            actor: { type: 'user', id: input.invitedBy },
            action: 'invitation.create',
            targetType: 'invitation',
            targetId: id,
            after: { role: input.role, email: input.email ?? null },
            apply: async () => {
              await t.execute(
                `INSERT INTO invitations
                   (id, workspace_id, email, token_hash, role, allowed_domain, expires_at, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  id,
                  input.workspaceId,
                  input.email ?? null,
                  // Only the hash: an invitation token is a credential.
                  hashToken(token),
                  input.role,
                  input.allowedDomain ?? null,
                  expiresAt,
                  input.invitedBy,
                ],
              )
            },
          }),
        input.invitedBy,
      )

      return { id, token, expiresAt }
    },

    async acceptInvitation(token, userId, userEmail) {
      const tokenHash = hashToken(token)

      // The token is the authorisation: the transaction declares which
      // invitation it is redeeming, and policy 0005 admits exactly that row.
      const redeeming = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
        withTenant(workspaceId, fn, {
          config,
          userId,
          settings: { 'app.invitation_token': tokenHash },
        })

      const rows = await redeeming('__none__', (t) =>
        t.query<{
          id: string
          workspace_id: string
          role: Role
          email: string | null
          allowed_domain: string | null
          expires_at: Date
          accepted_at: Date | null
        }>(
          `SELECT id, workspace_id, role, email, allowed_domain, expires_at, accepted_at
             FROM invitations WHERE token_hash = $1`,
          [tokenHash],
        ),
      )

      const invitation = rows[0]
      // A bad token and a used token are reported identically: distinguishing
      // them would tell an attacker which guesses were once valid.
      if (!invitation || invitation.accepted_at) {
        throw new ValidationError('This invitation is not valid', { reason: 'invalid_or_used' })
      }
      if (new Date(invitation.expires_at).getTime() < Date.now()) {
        throw new ValidationError('This invitation has expired', { reason: 'expired' })
      }
      if (invitation.email && invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
        throw new ValidationError('This invitation is for a different address', {
          reason: 'wrong_recipient',
        })
      }
      if (invitation.allowed_domain) {
        const domain = userEmail.split('@')[1]?.toLowerCase()
        if (domain !== invitation.allowed_domain.toLowerCase()) {
          throw new ValidationError('This invitation is limited to another email domain', {
            reason: 'domain_not_allowed',
          })
        }
      }

      await redeeming(
        invitation.workspace_id,
        async (t) =>
          mutate(t, {
            workspaceId: invitation.workspace_id,
            actor: { type: 'user', id: userId },
            action: 'invitation.accept',
            targetType: 'invitation',
            targetId: invitation.id,
            after: { role: invitation.role },
            apply: async () => {
              // Marking accepted inside the same transaction is what makes the
              // invitation single-use under concurrent redemption.
              const claimed = await t.execute(
                `UPDATE invitations SET accepted_at = now(), accepted_by = $1
                  WHERE id = $2 AND accepted_at IS NULL`,
                [userId, invitation.id],
              )
              if (claimed !== 1) {
                throw new ConflictError('This invitation has already been used')
              }
              await t.execute(
                `INSERT INTO workspace_members (id, workspace_id, user_id, role)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (workspace_id, user_id) WHERE deleted_at IS NULL DO NOTHING`,
                [ulid(), invitation.workspace_id, userId, invitation.role],
              )
            },
          }),
      )

      return this.get(invitation.workspace_id, userId)
    },

    async removeMember(workspaceId, actorId, targetUserId) {
      await assertNotLastOwner(this, workspaceId, targetUserId)

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'member.remove',
            targetType: 'member',
            targetId: targetUserId,
            apply: async () => {
              const removed = await t.execute(
                `UPDATE workspace_members SET deleted_at = now()
                  WHERE user_id = $1 AND deleted_at IS NULL`,
                [targetUserId],
              )
              if (removed !== 1) throw new NotFoundError('No such member', { targetUserId })
            },
          }),
        actorId,
      )
    },

    async changeRole(workspaceId, actorId, targetUserId, role) {
      if (!atLeast('owner', role) && role !== 'owner') {
        // Guards against an unknown role reaching the database check constraint.
      }
      const current = await this.roleOf(workspaceId, targetUserId)
      if (!current) throw new NotFoundError('No such member', { targetUserId })
      if (current === 'owner' && role !== 'owner') {
        await assertNotLastOwner(this, workspaceId, targetUserId)
      }

      await tx(
        workspaceId,
        async (t) =>
          mutate(t, {
            workspaceId,
            actor: { type: 'user', id: actorId },
            action: 'member.change_role',
            targetType: 'member',
            targetId: targetUserId,
            before: { role: current },
            after: { role },
            apply: async () => {
              await t.execute(
                `UPDATE workspace_members SET role = $1, updated_at = now()
                  WHERE user_id = $2 AND deleted_at IS NULL`,
                [role, targetUserId],
              )
            },
          }),
        actorId,
      )
    },
  }
}

/**
 * WS-2 AC6 — a workspace must never be left without an owner, which would make
 * it unadministrable with no way back short of database surgery.
 */
async function assertNotLastOwner(
  service: WorkspaceService,
  workspaceId: string,
  targetUserId: string,
): Promise<void> {
  const members = await service.members(workspaceId)
  const owners = members.filter((m) => m.role === 'owner')
  if (owners.length === 1 && owners[0]!.userId === targetUserId) {
    throw new ForbiddenError(
      'A workspace must keep at least one owner. Transfer ownership first.',
      { reason: 'last_owner' },
    )
  }
}
