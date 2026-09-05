# Chorus

**A self-hostable product workspace for teams that build with coding agents.**

[Website](https://maximumtrainer.github.io/chorus/) ·
[Architecture](architecture.md) ·
[Build plan](plan.md) ·
[How we work](CLAUDE.md) ·
[Contributing](CONTRIBUTING.md)

> **Status: pre-alpha, Phase 1.** The foundations are real and tested; almost
> nothing a user would recognise as a product exists yet. **The interface is
> one screen** — a collaborative document editor — and everything else is an
> HTTP API. See [Progress](#progress) for exactly how far along it is.

---

## Vision

Capture product intent once. Enrich it automatically with your team's own
context. Shape it collaboratively into unambiguous work, and hand that work to
people or to coding agents — without losing the *why* between steps.

Today that intent is scattered. A decision is made in Slack, restated in a
ticket, half-remembered in a PRD, and by the time a coding agent sees it, the
reasoning is gone and the agent is guessing. Chorus keeps the thread: every task
and pull request links back to the conversation, recording or document it came
from.

**What Chorus is not:** an issue-tracker replacement, a deployment platform, a
proprietary model, or a mobile product. It integrates with the trackers you
already use and treats every model provider as swappable.

### The principles that decide arguments

When two designs both work, the one that better satisfies the earlier principle
wins. In full in [architecture.md §2](architecture.md).

1. **Intent is the primary artefact.** Tasks and pull requests are derived from
   chats, recordings and documents, and keep a traversable link back. A feature
   that severs that link is wrong.
2. **Context is compiled, not curated.** Nobody maintains a wiki by hand.
   Signals are ingested, entities extracted, pages generated; human corrections
   are re-ingested and change future output.
3. **Humans hold the gates.** Every autonomous step passes a checkpoint whose
   policy is `auto`, `ask` or `never`. The platform default is `ask`, and it
   fails closed — an unconfigured workspace is never autonomous by omission.
4. **Bring your own agent and model.** No capability depends on one vendor.
   Every model call goes through one provider-agnostic interface; every coding
   agent is an adapter; every agent-facing capability is reachable over MCP.
5. **Self-host first.** `docker compose up` yields a working system on one host.
   The only mandatory external dependency is the model endpoint, which may be
   local.
6. **Everything is auditable.** Every mutation, tool call and unit of spend is
   recorded and attributable, in the same transaction as the change itself.
7. **Boring where possible.** The interesting parts are the context engine and
   the agent runtime. Everything else is mainstream technology.
8. **Contracts before implementations.** Connectors, workflows, coding adapters
   and chat surfaces are versioned plugin interfaces with shared test kits.
9. **Outside-in and test-first.** Behaviour is an executable acceptance test
   before it is an implementation.

---

## Progress

Everything in this table is generated from the repository, never typed — see
[`scripts/sync-docs.mjs`](scripts/sync-docs.mjs). A test fails the build if it
drifts from the code.

<!-- progress -->
| | |
|---|---|
| **Passing tests** | 399 |
| **HTTP routes**, each with a declared required role | 22 |
| **Catalogued requirements** | 116 (66 must-have) |
| **Requirements with a test that names them** | 5 — `WS-1`, `WS-2`, `WS-3`, `WS-4`, `WS-5` |

| Phase | Requirements | With a test |
|---|---|---|
| Phase 0 | 7 | 5 |
| Phase 1 | 35 | 0 |
| Phase 2 | 14 | 0 |
| Phase 3 | 9 | 0 |
| Phase 4 | 12 | 0 |
| Phase 5 | 25 | 0 |

<sub>Recorded from `875e0b8` on 2026-09-01 by `pnpm site:record`. Regenerate this block with `pnpm docs:sync`.</sub>
<!-- /progress -->

**"Has a test" is not "is finished."** Several of those requirements have
acceptance criteria deliberately deferred, each tracked as an open issue — the
team charter is stored but does not yet reach an agent prompt, and coding-job
permissions have no route to guard. Nothing here is production-ready.

### What actually works

- **Identity and tenancy.** Email/password and OIDC sign-in, workspaces,
  invitations, teams with charters and checkpoint policies. Workspace isolation
  is enforced by Postgres row-level security, not by application code — the
  application role has no `BYPASSRLS`, so a query issued outside a tenant
  context reads nothing rather than everything.
- **Permissions.** Every route declares the role it requires, and that
  declaration is what enforces it: authorisation is attached from the same table
  the permission suite enumerates, so a route cannot be mounted without the
  check it describes.
- **Audit.** Every mutation writes its audit row in the same transaction as the
  change. Refusals are recorded too, with the actor and the role required.
- **The model layer.** A provider-agnostic router with capability fallback, and
  versioned prompt files. No provider SDK may be imported outside
  `packages/llm`, enforced by a dependency-boundary check.

Real recorded transcripts of the above — including the refusals, which are
where the guarantees are visible — are on the
[website](https://maximumtrainer.github.io/chorus/#working).

### What does not exist yet

The web app, the browser extension, the agent runtime, the context engine,
coding sandboxes, the MCP server, and every connector. That is most of the
product. [plan.md](plan.md) has the order it arrives in.

---

## Running it

Requires **Node 22+**, [pnpm](https://pnpm.io) and **Docker**.

```bash
git clone https://github.com/MaximumTrainer/chorus.git
cd chorus
pnpm install
```

`pnpm install` also points git at [`.githooks`](.githooks), which is how the
verify and documentation gates become active.

### Bring up the infrastructure

Postgres, Redis and MinIO, on one host:

```bash
docker compose -f deploy/docker-compose.yml up --detach --wait
```

### Run the gate

This is the whole check, and exactly what CI runs:

```bash
pnpm verify
```

If it passes locally and fails in CI, that divergence is itself a bug.

### Individual suites

| Command | Runs |
|---|---|
| `pnpm test` | unit, integration and contract suites |
| `pnpm test:acceptance` | the product as a user or agent sees it (needs Docker) |
| `pnpm test:nfr` | tenancy, permissions, bootstrap and documentation suites |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm lint` | ESLint, including the dependency-boundary rules |

Everything proving one requirement is reachable by its id:

```bash
pnpm test --grep WS-4
```

That works because the requirement id is mandatory in the test name — which is
what keeps traceability mechanical rather than clerical.

### Regenerating the generated documentation

```bash
pnpm site:record   # re-record figures and API transcripts (needs Docker)
pnpm docs:sync     # rewrite the README progress block from them
pnpm site          # build the website into website/dist
```

---

## How this project is built

Chorus is developed **outside-in and test-first**, and
[`CLAUDE.md`](CLAUDE.md) is not advisory:

> No implementation code is written until a test that requires it exists and
> fails for the right reason.

In practice that means a change starts from a requirement id, gets an
acceptance test that fails for the missing behaviour, and works inwards —
integration, unit, then the minimum implementation that turns the current red
test green.

Two gates enforce it mechanically, because a rule nobody checks is one that
quietly stops being true:

- **`pre-push`** runs `pnpm verify`, added after a commit was pushed with a
  failing gate: it had been run, but its exit code was not read.
- **`commit-msg`** refuses a source change that neither updates documentation
  nor says why it does not need to. "No documentation needed" becomes a claim
  recorded in history that a reviewer can disagree with, rather than an
  omission nobody can see:

  ```
  Docs: none — pure extraction, no recorded decision changed.
  ```

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the full workflow — branches, commit
conventions, DCO sign-off, and what a pull request must state.

### Good places to start

Connectors, workflows, coding adapters and chat surfaces are plugin interfaces
with typed contracts and fixture-based test kits, so you can add one without
touching core. Every [issue](https://github.com/MaximumTrainer/chorus/issues)
carries its full requirement text, Given/When/Then acceptance criteria and an
ordered outside-in test plan — the specification is done before you start.

---

## Licence

[Apache-2.0](LICENSE). By contributing you certify the
[Developer Certificate of Origin](https://developercertificate.org/).
