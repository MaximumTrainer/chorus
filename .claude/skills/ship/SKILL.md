---
name: ship
description: Commit finished work, push it to remote main, and watch CI until it is green. Use when asked to "commit and push", "push to remote main", "commit into remote when complete", or "verify the build is green" after a change. Covers the pre-push verify gate, the commit-msg documentation gate, this repository's commit message shape, and reading a CI failure.
---

# Shipping a change

Nothing is "done" because the code is written. It is done when `pnpm verify`
passes, the commit says what it proves, and the **remote** build is green.

## 1. Check the definition of done first

`CLAUDE.md` §8, all of it. In particular: an acceptance test carrying the
requirement id existed **before** the implementation and now passes; new tenant
tables have RLS policies and tenancy tests; new routes and MCP tools have
permission tests; new mutating operations write audit events; no test was
skipped, weakened or deleted to reach green.

## 2. Run the gate, and read its exit code

```bash
pnpm verify        # typecheck && lint && test && test:acceptance && test:nfr
```

This is exactly what CI runs (NFR-12 AC4) — a local pass with a CI failure is
itself a bug. It needs Docker running: the integration and NFR suites use a real
Postgres and Redis through Testcontainers.

Long enough to be worth backgrounding, but **never** pipe it in a way that
swallows the exit status. A push once went out on a failing gate because the
gate had been run and its exit code had not been read; that is why `pre-push`
exists.

Browser journeys are not in `verify` and CI runs them:

```bash
pnpm test:e2e
```

## 3. Commit

Conventional Commits, requirement id in the subject and on its own line in the
body, DCO sign-off:

```
feat(documents): export that arrives intact somewhere else (DOC-7)

<what the change does, and the one thing that was easy to get wrong>

Proven by: apps/api/test/acceptance/export.test.ts — AC1, AC2, AC4, AC5.

Deliberately left out: AC3, PDF — it wants Chromium in the worker image,
which is a deployment-weight decision deserving an ADR.

DOC-7
```

Commit with `git commit -s`. Prose over bullet lists; say what was left out and
why, because the next person's first question is whether the requirement is
finished.

### The documentation gate

`commit-msg` refuses a commit touching `apps/*/src/`, `packages/*/src/`,
`packages/db/migrations/` or `workflows/prompts/**` that neither changes
documentation nor carries a reason:

```
Docs: none — pure extraction, no recorded decision changed.
```

At least 15 characters, and it is a claim recorded in history. If the change
alters a decision in `architecture.md`, edit it — or add an ADR under
`docs/adr/` — in the **same** commit. Test-only commits are exempt.

Do not use `--no-verify` on either hook without saying so and why.

## 4. Push

Work lands on `main` in this repository.

```bash
git push origin main
```

`pre-push` runs `pnpm verify` again. If it fails, the push is aborted — fix the
failure, do not bypass it. Check the result: `git rev-list --left-right --count
origin/main...main` must print `0	0` afterwards. A pipe that hides git's exit
code has hidden a failed push here before.

## 5. Watch the remote build

The push is not the deliverable; the green run is.

```bash
gh run list --branch main --limit 3
gh run watch <run-id> --exit-status
```

CI has three jobs: `verify (fresh clone)` (the gate plus the browser journeys
against a real Postgres, Redis and an OpenTelemetry collector), `reference
deployment` (the compose stack stood up and smoked, NFR-1 AC1), and
`performance` (nightly only).

If it fails:

```bash
gh run view <run-id> --log-failed
```

Reproduce locally, fix, and ship again — see `green-main`. Failure artefacts:
Playwright traces are uploaded as `playwright-traces`; compose failures print
`migrate`, `api` and `worker` logs in the job.

## 6. Report

State the requirement id, which test proves it, what was deliberately left out,
and the CI run's conclusion **with its id**. Never describe work as complete
while a test is red, skipped or removed, or while the remote build is unknown.

Then consider `backlog-sync` to close the issue and file what remains.
