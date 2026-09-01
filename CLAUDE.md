# CLAUDE.md — how work is done in this repository

This file governs **every** change made to Chorus, by a human or by an agent. It is not advisory.

Chorus is developed **outside-in and test-first**. Read `architecture.md` before writing code — it is normative, and §23 of it describes the testing architecture this file operationalises.

---

## 1. The one rule

> **No implementation code is written until a test that requires it exists and fails for the right reason.**

"Fails for the right reason" means the failure message describes the missing behaviour — not a typo, not a missing import, not a syntax error. Run the test, read the failure, and confirm it is the failure you intended before writing a line of production code.

If you find yourself writing production code and cannot name the failing test that demanded it, stop and write that test.

---

## 2. Outside-in, in order

Work from the outside of the system inwards. Each layer is written only because the layer above it demanded it.

```
1. Requirement            e.g. TASK-4 "Push to tracker with status mirror and conflict state"
       ↓  write it, watch it fail
2. Acceptance test        black box, through a real public entry point (HTTP API, UI, or MCP)
       ↓  it fails because a route/screen/tool is missing
3. Integration test       one seam: route + database, worker + queue, connector + cassette
       ↓  it fails because a service or repository is missing
4. Unit test              one pure function, mapper or state machine
       ↓  it fails because that function is missing
5. Minimal implementation make the unit test pass, nothing more
       ↑  refactor with the test green
6. Walk back out          unit → integration → acceptance, each turning green in turn
```

You will spend most of your time in steps 3–5, but you never *start* there. The acceptance test is what proves the requirement; the inner tests are what make the design good.

**Never skip a layer to "save time."** An implementation with only unit tests does not demonstrate the requirement. An implementation with only an acceptance test is untestable at the seams and will rot.

### When to stop descending

Descend one layer only when the current failing test cannot be made to pass by an honest, small change at the current layer. If the acceptance test can be satisfied by a twenty-line route handler calling existing services, write the route handler — do not invent three new layers to have somewhere to put unit tests.

---

## 3. Starting any piece of work

1. **Find the requirement id.** Every task traces to an id from `architecture.md` §26 (`WS-1`, `BRAIN-4`, `INT-8`, `NFR-3`, …) and to a GitHub issue carrying its full text and acceptance criteria. If no id applies, the work needs a new requirement and an issue before it needs code.
2. **Read the issue's acceptance criteria.** They are written in Given/When/Then and are the specification. If they are ambiguous, resolve the ambiguity in the issue first — not in the code.
3. **Read `architecture.md`** for the subsystem you are touching. If your intended change contradicts it, change the document (or write an ADR) in the same pull request, with the reasoning. Silent divergence is the one unrecoverable mistake.
4. **Write the acceptance test first**, named with the requirement id, and watch it fail.
5. Work inwards.
6. **Definition of done** is §8 below — all of it.

---

## 4. Test layers: what belongs where

| Layer | Location | Runner | Boundary | Budget |
|---|---|---|---|---|
| **Acceptance** | `apps/*/test/acceptance/**` | Playwright (UI journeys), Vitest HTTP harness (API), MCP client harness (agent-facing) | The product as a user or agent sees it | < 90 s per journey |
| **Integration** | `<package>/test/integration/**` | Vitest + Testcontainers | Exactly one seam | < 5 s per test |
| **Contract** | `<package>/test/contract/**` | Vitest + recorded cassettes | A plugin interface (connector, adapter, chat surface, workflow) | < 2 s per test |
| **Unit** | co-located `*.test.ts` | Vitest | One module, no I/O at all | < 50 ms per test |

**Acceptance tests use real infrastructure and fake externals.** Real Postgres, Redis and object storage; faked model provider, git host, trackers and chat surfaces. Never call a real model, a real tracker or a real network host from a test.

**The fakes are shipped code, not per-test improvisation.** They live in `packages/testing` and are maintained with the same care as production code, because their fidelity is what makes acceptance tests trustworthy:

- `FakeModelProvider` — deterministic, scriptable structured outputs and streams; records every request; can be told to fail, time out, or return schema-invalid output.
- `FakeGitHost` — branches, PRs, comments, deployments, and outbound webhooks fired back into the API.
- `FakeChatSurface` — implements `ChatSurface`, captures rendered messages, fires mention/reaction/action events.
- `FakeSandbox` — implements the `Sandbox` contract, applies a scripted diff and emits scripted job events with no container.
- Connector **cassettes** — recorded, redacted HTTP interactions in `packages/connectors/<kind>/__cassettes__/`.
- **World builder** — `aWorkspace().withTeam().withRepo(fixture).withTasks(…).build()` for readable arrange blocks with correct tenancy.

If you need a behaviour a fake does not have, extend the fake — do not stub around it in your test file.

---

## 5. How to write the tests

### Naming carries traceability

```ts
describe('TASK-4 push to tracker', () => {
  it('TASK-4: creates the external issue and stores the mapping', …)
  it('TASK-4: mirrors an external status change back to the task', …)
  it('TASK-4: marks sync_state=conflict when both sides changed', …)
})
```

`pnpm test --grep TASK-4` must run everything that proves TASK-4. This is how the requirement catalogue stays honest, so the id is mandatory in the test name.

### Structure is Given / When / Then

Mirror the issue's acceptance criteria one-to-one. One behaviour per test; if the name needs "and", it is two tests.

```ts
it('TASK-4: marks sync_state=conflict when both sides changed', async () => {
  // Given a task synced to a tracker issue
  const { task, tracker } = await aWorkspace().withTeam().withSyncedTask().build()
  // and both sides have changed since the last sync
  await api.patch(`/tasks/${task.id}`, { title: 'local edit' })
  await tracker.externallyUpdate(task.externalKey, { summary: 'remote edit' })

  // When the sync runs
  await worker.drain('connector.sync')

  // Then the link is marked as a conflict, and neither side is silently overwritten
  expect(await api.get(`/tasks/${task.id}`)).toMatchObject({ syncState: 'conflict' })
  expect(await tracker.get(task.externalKey)).toMatchObject({ summary: 'remote edit' })
})
```

### Assert on behaviour, never on internals

Assert through public entry points and observable outcomes: API responses, database rows a user could see, messages rendered to a fake surface, events emitted. Do not assert that a private method was called. A test that breaks when you rename an internal function without changing behaviour is a bad test — rewrite it rather than update it.

### Determinism is mandatory

`Clock`, `Random` and `IdGen` are injected and frozen in tests. No `sleep`; await an explicit condition. Every test creates its own workspace so the suite is parallel-safe. Snapshots are allowed only for serialised contracts (OpenAPI, MCP tool schemas, prompt front-matter, ADF/Markdown round-trips) — never for UI trees.

---

## 6. Rules that apply to every change

1. **Tenancy.** Any new tenant table gets `workspace_id`, an RLS policy in the same migration, and an entry in the tenancy suite. CI fails otherwise.
2. **Permissions.** Any new route or MCP tool declares its required role and scope, and gains a case in the permission suite covering each role.
3. **Audit.** Any new mutating operation writes its `audit_events` row **in the same transaction**, with a test proving it.
4. **Model calls.** Go through `packages/llm`. No provider SDK import outside that package; no model name in code. The dependency-boundary check enforces this.
5. **Prompts.** Live in `workflows/prompts/**` as versioned files with front-matter. Changing a prompt requires updating its golden fixture in the same pull request.
6. **External writes.** Any tool with `sideEffect: 'external'` passes the `before_external_write` checkpoint. A tool that writes externally without a checkpoint path is a bug, not a feature.
7. **Idempotency.** Every queue consumer and webhook handler is idempotent, with a duplicate-delivery test.
8. **Sandboxes.** Any change to the sandbox contract requires the sandbox security suite to still pass: no platform credentials, egress allow-list enforced, limits applied, path allow-list respected.
9. **Contracts.** Changing a plugin interface (connector, adapter, chat surface, workflow schema) is a semver event and requires the shared contract-test kit to pass for every existing implementation.
10. **Accessibility.** New primary screens and extension panels pass the axe suite; strings are externalised.
11. **Documentation.** A change that alters a decision in `architecture.md` updates it, or adds an ADR under `docs/adr/`, in the same pull request. This is enforced: the `commit-msg` hook refuses a commit touching source that neither changes documentation nor carries a `Docs:` line saying why none is needed. The escape hatch is deliberate — "no documentation needed" becomes a claim recorded in history that a reviewer can disagree with, rather than an omission nobody can see.

---

## 7. Anti-patterns — do not do these

- Writing production code first and adding tests afterwards to reach a coverage number. Retrofitted tests test what the code does, not what the requirement demanded.
- Writing only unit tests for a user-facing requirement.
- Deleting, skipping or `.only`-ing a failing test to get a pull request green. A red test is information; find out what it is telling you.
- Asserting on mock call counts as a substitute for asserting on outcomes.
- Mocking the module under test, or mocking your own database layer instead of using the real database in an integration test.
- Adding a `sleep` to make a flaky test pass.
- Committing a cassette or fixture containing real credentials or customer data.
- Introducing a new dependency, datastore or service without an ADR.
- Silently diverging from `architecture.md`.
- Broad `try/catch` that swallows an error, or a bare `any` used to bypass a type error rather than model the shape.

---

## 8. Definition of done

A change is done when **all** of the following are true:

- [ ] It advances a specific requirement id, named in the branch, the commits and the pull request.
- [ ] An acceptance test carrying that id existed before the implementation and now passes.
- [ ] Integration and unit tests exist for the seams and logic the acceptance test drove out.
- [ ] Every new tenant table has an RLS policy and a tenancy test; every new route or MCP tool has permission tests.
- [ ] Every new mutating operation writes an audit event, proven by a test.
- [ ] Typecheck, lint, dependency-boundary check and the full test suite pass locally.
- [ ] `architecture.md` and/or an ADR is updated if a recorded decision changed.
- [ ] The pull request states which test proves the requirement, and lists what was deliberately left out.
- [ ] No test was skipped, weakened or deleted to achieve green.

---

## 9. Commands

```bash
pnpm install              # bootstrap
pnpm dev                  # all services in one process, with fakes for externals
pnpm test                 # unit + integration + contract
pnpm test --grep TASK-4   # everything proving one requirement
pnpm test:acceptance      # acceptance suites (needs docker for Postgres/Redis/MinIO)
pnpm test:nfr             # tenancy, permission, redaction, sandbox security suites
pnpm typecheck lint       # static checks
pnpm db:migrate           # forward migrations
pnpm verify               # everything CI runs on a pull request
```

Run `pnpm verify` before opening a pull request. If it is slow, fix the slowness — do not skip the gate.

---

## 10. Conventions

- **Files** `kebab-case`; **types** `PascalCase`; **values** `camelCase`; **env** `SCREAMING_SNAKE` prefixed `CHORUS_`; **database** `snake_case`, plural tables.
- **Branches** `<req-id>/<slug>`, e.g. `task-4/tracker-status-mirror`.
- **Commits** Conventional Commits with the requirement id in the body, DCO sign-off (`git commit -s`).
- **Errors** one `AppError` hierarchy in `packages/core`, mapped to RFC 9457 problem details. Never throw strings; never swallow.
- **Validation** Zod schemas in `packages/core` are the single definition of every wire shape.
- **Dependency rule** `core` depends on nothing internal; `db` and `llm` depend only on `core`; feature packages depend on `core`/`db`/`llm` and never on each other except through `core` interfaces; apps depend on packages, never the reverse.

---

## 11. For agents working in this repository

You are subject to every rule above, and to these in addition:

- **Announce the requirement id and the test you are about to write before you write any code.** If you cannot name one, ask rather than guess.
- **Show the red.** Run the new test and report the actual failure output before implementing. A claim that a test "would fail" is not evidence.
- **Implement the minimum** that turns the current red test green. Do not build ahead of the tests, and do not add unrequested abstraction, configuration or extension points.
- **Report failures truthfully.** If a test fails, say so and paste the output. Never describe work as complete while a test is red, skipped or removed.
- **Do not touch unrelated code.** If you spot an adjacent problem, mention it or open an issue; do not fix it in the same change.
- **Respect the boundaries in §6** even when a shortcut would be faster. Tenancy, permission, audit, checkpoint and sandbox rules are the ones most costly to get wrong and least visible when broken.
- **Never fabricate a code pointer, citation, benchmark or test result.** If you did not run it, say you did not run it.
