# ADR-0011: Better Auth owns the identity tables, mapped to Chorus naming conventions

- **Status:** Accepted
- **Date:** 2026-09-01
- **Requirement:** WS-1
- **Supersedes:** nothing. Refines ADR-0003 (tenancy) and the stack decision in `architecture.md` §5.1.

## Context

`architecture.md` §5.1 chose Better Auth, on the grounds that hand-rolling
authentication is a liability. Before building WS-1 a timeboxed spike
(`plan.md` §8) established what Better Auth actually requires of the schema.

It owns four tables:

| Table | Purpose | Fields |
|---|---|---|
| `user` | the person | `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt` |
| `session` | an active session | `expiresAt`, `token`, `ipAddress`, `userAgent`, `userId` |
| `account` | a credential — password hash **or** a linked OIDC provider | `providerId`, `accountId`, `password`, `accessToken`, `refreshToken`, `scope`, `issuer`, `userId` |
| `verification` | email-verification and reset tokens | `identifier`, `value`, `expiresAt` |

Two frictions surfaced:

1. **Naming.** Better Auth defaults to singular, camelCase (`user`,
   `emailVerified`). `architecture.md` §28 mandates snake_case identifiers and
   plural tables. Migration `0001` already created a `users` table that
   overlaps with Better Auth's `user`.
2. **Ownership of credentials.** `account.password` holds the password hash, so
   Better Auth — not Chorus — owns credential storage and verification.

## Decision

Adopt Better Auth, and **map its models onto Chorus naming conventions** using
its `modelName` and `fieldName` overrides, rather than accepting its defaults or
relaxing §28.

- Its four tables become `users`, `sessions`, `accounts`, `verifications`, with
  snake_case columns.
- The `users` table created in migration `0001` is reconciled to Better Auth's
  required shape by a forward migration, not by editing `0001`. Nothing is
  deployed, so editing would be easier — but the forward-only rule
  (`architecture.md` §8.4) is worth more than the convenience, and this is the
  first opportunity to demonstrate it rather than assert it.
- These four tables are **not** tenant tables: a user exists above the workspace
  boundary because one person may belong to several workspaces (WS-2). They
  therefore carry no `workspace_id`, get no RLS policy, and are correctly absent
  from `TENANT_TABLES`. Membership and its role live in `workspace_members`,
  which *is* a tenant table.
- Credential handling — hashing parameters, verification tokens, session
  issuance and rotation — is Better Auth's. Chorus asserts the *behaviour*
  required by WS-1's acceptance criteria (verification required before sign-in,
  provider-verified email before account linking, lockout, revocation) rather
  than reimplementing the mechanism.

## Consequences

**Good.** No hand-rolled password or session handling. OIDC, account linking and
verification arrive as configuration. Conventions in §28 hold, so no reader has
to remember an exception.

**Costs.** Mapping configuration must be kept in step with Better Auth upgrades;
a schema change on their side is a migration on ours. The mapping is asserted by
the migration suite, so a drift fails the build rather than surfacing at
runtime.

**Rejected alternatives.**

- *Accept Better Auth's defaults.* Four tables breaking the naming convention,
  and a permanent exception every contributor must hold in their head.
- *Hand-roll authentication.* Explicitly called a liability in §5.1. The spike
  found no blocker that would justify reversing that.

## Verification

WS-1's acceptance criteria are asserted against behaviour, not implementation:
verification required before sign-in; single-use, expiring tokens; account
linking only on a provider-verified email; bounded failed attempts; immediate
session revocation. Those tests remain valid if Better Auth is ever replaced.
