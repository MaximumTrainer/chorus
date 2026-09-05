---
name: green-main
description: Check whether remote main is green and fix it when it is not. Use when asked to "check remote main is green", "fix remote main", "is the build broken", or before starting new work. Finds the latest run, reads the real failure out of the logs, reproduces it locally, and lands the fix.
---

# Getting main green again

A red `main` outranks every other task. Nothing new starts on top of a broken
build.

## 1. Look

```bash
gh run list --branch main --limit 5
```

Also check the local tree is actually pushed — a "green" build that does not
include your work proves nothing:

```bash
git fetch origin && git rev-list --left-right --count origin/main...main
```

`0	4` means four commits never reached the remote. That has happened here: the
`pre-push` gate failed and git's exit code was masked by a pipe. If the count is
non-zero, the real task is `ship`, not a CI fix.

## 2. Read the failure, not the summary

```bash
gh run view <run-id>                # which job
gh run view <run-id> --log-failed   # the actual output
```

Get to the assertion or the stack trace. "Tests failed" is not a diagnosis.

Where failures usually come from, in this repository:

- **`verify (fresh clone)`** — typecheck, lint, then the unit/integration/
  contract, acceptance and NFR suites, against a real Postgres and Redis and a
  real OpenTelemetry collector. A test green locally and red here is often
  ordering, a leaked fixture between workspaces, or a timing assumption.
- **Browser journeys** — Playwright traces are uploaded as the
  `playwright-traces` artefact; download it rather than guessing.
- **`reference deployment`** — the compose stack. The job prints `migrate`, `api`
  and `worker` logs on failure. Common causes are a migration that cannot run
  twice, a healthcheck that never reports ready, or the readiness probe
  disagreeing with the schema.
- **`performance`** — nightly, and against a runner that is *not* the reference
  host in `architecture.md` §24. A pass bounds the implementation; it does not
  certify the target.

## 3. Reproduce locally before changing anything

```bash
pnpm verify
pnpm test --grep AGENT-3     # one requirement
pnpm test:e2e
```

Docker must be running. If it will not reproduce, the difference between local
and CI is itself the bug (NFR-12 AC4) — find it rather than papering over it.

Flakiness is a diagnosis of last resort, and re-running is not a fix. A test
that passes on retry is telling you about a real race.

## 4. Fix it honestly

A red test is information. Do not skip it, weaken its assertion, delete it or
add a sleep. If the test is wrong, say why it is wrong and fix the test as a
deliberate change with its reasoning in the commit message.

A helper that discards an outcome turns a real failure into a meaningless one
("expected 0 to be 1"). Making the helper assert what it assumed is often the
whole fix.

## 5. Land it

Use `ship`: `pnpm verify`, a commit naming the requirement id and the failure it
repairs, push, and watch the run to green with
`gh run watch <run-id> --exit-status`. Report the run id and its conclusion.
