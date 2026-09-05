---
name: tdd
description: Drive a Chorus change outside-in, test-first, as CLAUDE.md requires. Use whenever implementing or changing behaviour in this repository - a requirement, a bug fix, or a failing acceptance criterion. Covers which layer to write, how to name tests so they trace to a requirement id, how to show the red, and the cross-cutting rules (tenancy, permissions, audit, checkpoints) a change must satisfy before it is done.
---

# The cycle

`CLAUDE.md` §1 is the rule: **no implementation code until a test that requires
it exists and fails for the right reason.** This skill is how that is carried
out here; read `CLAUDE.md` §§1–8 and the relevant part of `architecture.md`
before starting.

```
requirement id → acceptance test (red) → integration test (red) → unit test (red)
   → minimal implementation (green) → refactor → walk back out to acceptance
```

Descend a layer only when the current red test cannot be made to pass by an
honest, small change at the current layer. A twenty-line route handler calling
existing services is a legitimate way to make an acceptance test pass.

## Where each test goes

| Layer | Location | Command | Budget |
|---|---|---|---|
| Acceptance | `apps/*/test/acceptance/**`, browser journeys in `test/e2e/**` | `pnpm test:acceptance`, `pnpm test:e2e` | < 90 s |
| Integration | `<package>/test/integration/**` | `pnpm test` | < 5 s |
| Contract | `<package>/test/contract/**` | `pnpm test` | < 2 s |
| Unit | co-located `*.test.ts` | `pnpm test` | < 50 ms |
| Non-functional | `test/nfr/**` | `pnpm test:nfr` | — |

Run one requirement's proof with `pnpm test --grep TASK-4`, which is why the id
is mandatory in every test name:

```ts
describe('TASK-4 push to tracker', () => {
  it('TASK-4: marks sync_state=conflict when both sides changed', …)
})
```

One behaviour per test. If the name needs "and", it is two tests.

## Real infrastructure, faked externals

Real Postgres, Redis and object storage; never a real model, tracker, git host
or network call. The fakes are shipped code in `packages/testing` —
`FakeModelProvider`, `FakeGitHost`, `FakeChatSurface`, `FakeSandbox`, connector
cassettes, and the `aWorkspace().withTeam().withRepo(…).build()` world builder.
**Extend a fake rather than stubbing around it in a test file.**

Determinism is mandatory: `Clock`, `Random` and `IdGen` are injected and frozen,
every test builds its own workspace, and no test sleeps — await the condition.

## Show the red

Run the new test and **paste the actual failure** before implementing. Check the
message describes the missing behaviour, not a typo or a missing import.

Helpers that swallow an outcome produce useless reds. A helper that drives a run
to a gate should assert the run got there, so a failure says why:

```ts
const outcome = await executor.run(workspaceId, run.id)
expect(outcome.status, `should have paused at the gate: ${outcome.error ?? ''}`)
  .toBe('waiting_human')
```

Otherwise the failure reads "expected 0 to be 1" and says nothing.

## Then the minimum

Implement only what turns the current red green. No unrequested abstraction,
configuration or extension point. Refactor with the test green.

## Cross-cutting rules a change must satisfy (CLAUDE.md §6)

- **Tenancy** — a new tenant table gets `workspace_id`, an RLS policy in the same
  migration, and a case in `test/nfr/**`.
- **Permissions** — a new route or MCP tool declares its role and scope and gains
  a permission-suite case per role.
- **Audit** — a new mutating operation writes its `audit_events` row in the same
  transaction, proven by a test.
- **Model calls** — through `packages/llm` only. No provider SDK import elsewhere,
  no model name in code.
- **Prompts** — versioned files under `workflows/prompts/**`; a change updates its
  golden fixture in the same commit.
- **External writes** — `sideEffect: 'external'` passes `before_external_write`.
- **Idempotency** — every queue consumer and webhook handler has a duplicate-delivery test.
- **Contracts** — changing a plugin interface is a semver event; the shared
  contract-test kit must pass for every implementation.

## Do not

Retro-fit tests after the code. Write only unit tests for a user-facing
requirement. Skip, `.only` or delete a red test to get green. Assert on mock call
counts instead of outcomes. Mock the database instead of using a real one.
Add a `sleep`. Touch unrelated code — mention it or file an issue instead.

Finish with `ship`.
