# ADR-0016: The migrator keeps a ledger, refuses edited migrations, and adopts a pre-ledger database only when told to

- **Status:** Accepted
- **Date:** 2026-09-05
- **Requirement:** NFR-1 AC5
- **Supersedes:** nothing. Corrects a claim in `architecture.md` §8.4 and in `packages/db/src/migrate.ts` that was never true.

## Context

`applyMigrations` read every `.sql` file in `packages/db/migrations` and executed
all of them, unconditionally, on every invocation. There was no record of what a
database had already seen.

That works exactly once per database. On the second run:

```
error: relation "users" already exists
```

The migrator runs as a one-shot on every `docker compose up`, so this is not an
edge case: it is every restart of every deployment whose volumes were not wiped,
and it is the ordinary development loop. `migrate.ts` claimed the files were
"written so that re-running is a no-op"; 52 of the 56 `CREATE TABLE` statements
have no `IF NOT EXISTS`, so they are not.

CI never saw it because the `reference deployment` job always starts from empty
volumes — the failure survived precisely because the only thing exercising the
stack always exercised the first run.

## Decision

**A `schema_migrations(filename, checksum, applied_at)` ledger**, created by the
runner rather than by a migration — a migration recording that migrations have
been applied would have to run before the table it writes to exists.

**Each migration and its ledger row commit together.** Written apart, a crash
between them leaves the ledger lying in one direction or the other, and the next
start either re-runs DDL that already applied or skips DDL that never did. This
needed one new seam, `AdminConnection.withOwnerTransaction`: the pooled
`execute` takes whichever connection is free, so a `BEGIN` issued through it can
land on a different backend from the statements it was meant to wrap.

**A file whose checksum no longer matches is refused, not skipped.** An edited
migration that is silently skipped leaves two deployments claiming the same
schema version with different schemas, and nothing anywhere says which one a bug
report came from. The remedy is a new migration, which is what forward-only
means.

**A database with a schema but no ledger stops the migrator**, with a message
naming the one-time step. `pnpm db:migrate --baseline` (or `CHORUS_DB_BASELINE=1`,
since the compose stack has no argv to pass) records the current files as applied
without running them.

## Why baseline is explicit rather than automatic

Adopting automatically is one line and it is wrong. The runner can see that a
schema exists; it cannot see *which* migrations produced it. A deployment
upgraded across two releases has the older release's schema and the newer
release's files, and silent adoption would mark the new ones applied — a missing
table that surfaces later as a runtime error far from its cause.

Failing loudly costs an operator one documented command, once. It is the same
reasoning as the checksum refusal: a loud failure beats two deployments that
disagree about what they are.

## Consequences

- Restarting against an existing volume works, which is what NFR-1 AC5 asks for.
- Migrations no longer have to be written re-runnably. Existing ones are
  unchanged; new ones need not carry defensive `IF NOT EXISTS`.
- **Editing an applied migration now fails the build for anyone who has already
  applied it.** That is the intent, and it is a change in what contributors may
  do: correcting a migration means adding another.
- Every database created before this change needs the one-time `--baseline`.
  There is no fleet to migrate — but the developer volume on any machine that has
  run Chorus is in this state.
- CI's `reference deployment` job now starts the stack, smokes it, restarts it
  against the same volumes, and smokes it again. The restart is the assertion;
  without it this defect would return unseen.

## What is deliberately not decided

**Concurrent migrators.** Two migrators racing can both see a file as unapplied
and both run it; one loses on the ledger's primary key or on the DDL itself.
That race existed before this change and is unchanged by it — the migrator is a
one-shot that runs before `api`, precisely so it does not happen. An advisory
lock would close it and is a few lines, but nothing today demands it, and
`CLAUDE.md` §11 says not to build ahead of the tests. Filed rather than fixed.
