# Phase 0 gate — Foundations

Run on 2026-09-03, following the procedure in `plan.md` §10. A phase closes with
evidence, not with consensus that it feels done, so every criterion below names
what was executed rather than asserting a state.

---

## 1. Exit criteria

| Criterion | Evidence |
|---|---|
| `docker compose up` on a clean host reaches a working system (NFR-1 AC1) | **Run, not reasoned about.** The stack was built and started locally; all five services reached healthy; four smoke assertions passed against the running system — liveness, readiness (database reachable *and* schema current), migrations having created real tables, and an unauthenticated write refused. CI now performs the same build-and-smoke on every run. |
| A user signs up, creates a workspace, connects a repository, and asks a question about the code — receiving a streamed answer citing real files at a real commit | `apps/api/test/acceptance/walking-skeleton.test.ts`, through real HTTP end to end. |
| Tenancy suite green for every tenant table; no table lacks an RLS policy (NFR-3 AC1, AC2) | 90 cases, enumerated **from the live schema** rather than a hand list — it grew from 38 across the phase without anyone adding a case. |
| Dependency-boundary check green (NFR-2 AC1, NFR-3 AC3) | `test/nfr/boundaries.test.ts`. Rules now cover provider SDKs, database drivers, queue backends and tracing SDKs. |
| Every mutating repository method writes an audit event in the same transaction (NFR-5 AC1) | One `mutate` wrapper; no change without a record and no record without a change. |
| The benchmark repository indexes within budget (BRAIN-2 AC6) | `pnpm test:perf`. **Passes** — 412 s projected for 500k LOC against a 900 s budget. The margin is thinner than that suggests and is recorded in #154; see §5 below. |
| One trace spans request → queue → worker → model call (NFR-5 AC2) | `test/nfr/tracing.test.ts`, asserting the spans share one trace **and are correctly parented**. |
| Decisions closed: D-6 sandbox runtime, D-5 model tier defaults | ADR-0014 and ADR-0015. D-5 was closed on narrower terms than `architecture.md` §27 asked for, and says so; the remaining half is #152. |

## 2. Requirement sweep

The Phase 0 milestone is empty. Seven issues closed, six moved with a written
reason on each, three epics moved out of the milestone entirely — an epic tracks
a family across phases and can never close *at* one, so leaving them in would
have made the milestone uncloseable and the gate meaningless.

**Closed:** WS-1 #16, WS-2 #17, WS-3-repositories #148, WS-5 #20, WS-4-AC4 #150,
INT-1 #113, BRAIN-2 #57.

**Moved to Phase 1**, each because a named criterion depends on something Phase 1
builds: WS-3 #18 (charter must reach an agent's prompt), WS-4 #19 (MCP permission
parity), INT-2 #114 (indexing on connect, enqueue on push, Jira), NFR-2 #133
(embedding cache not wired), NFR-12 #143 (seed data), WS-3-AC2 #146.

**Moved to Phase 5**: NFR-1 #132 (Helm), NFR-3 #134 (sandbox secrets, rate
limits, SBOM), NFR-5 #136 (metrics).

## 3. Suite check

| Suite | Cases | Grew because |
|---|---|---|
| unit + integration + contract | 465 | new packages: connectors, indexer, queue, telemetry |
| acceptance | 103 | auth, workspaces, teams, tokens, OAuth, repositories, walking skeleton |
| NFR | 328 | tenancy 38 → 90 and permissions 74 → 94, both **by enumeration** rather than by hand |
| performance | 3 | new; nightly, not in `verify` |

The two suites that grow by themselves are the point. A tenancy suite that must
be extended by hand is one that silently stops covering the newest table, and
the newest table is the least reviewed.

## 4. Decision review

Both decisions with a Phase 0 deadline are recorded as ADRs with consequences
and a trigger to revisit. ADR-0015 additionally records what it did **not**
decide, rather than inventing evidence for a ranking that needs an evaluation
set Phase 1 has to build first.

## 5. Debt entered, not carried

| Issue | What |
|---|---|
| #152 | Which model per tier — needs the evaluation set §27 asks for |
| #153 | Compile for production rather than running `tsx` in the image |
| #154 | Indexing margin is thinner than it looks, and inserts are per-row |
| #147 | Scope artefact queries by team, once there are artefacts |

## 6. Things a green suite could not have told us

Recorded because they are the argument for running the thing rather than
trusting the tests, and the next phase should expect more of them.

Bringing the stack up for the first time found **five** failures invisible to a
passing test run: corepack's expired signing key in the base image; a missing
`.dockerignore` overwriting the image's `node_modules` with the host's; Node's
type stripping being unable to resolve this codebase's `.js` specifiers at all;
`pg`'s CommonJS exports defeating a named import outside a bundler; and a
development master key that decoded to 31 bytes — refused, correctly, by a check
whose comment says "accepting a short key would give a system that merely looks
encrypted".

The indexing benchmark's first version truncated files mid-construct, so 104 of
207 did not parse. Failures take the cheap path, and the benchmark reported four
times the real throughput. Reading the parse-failure count in the output is the
only reason that was caught.

Building GitLab second — as INT-2's own notes advised — found that the contract
kit had baked in a GitHub-shaped assumption that every source signs its webhook
body. The fix was to make the difference *declared* rather than to weaken the
assertion.

---

## Verdict

**Phase 0 closes.** Every exit criterion has executed evidence, the milestone is
empty, no suite is red, no test is skipped, and no divergence from
`architecture.md` is carried forward undocumented.

Phase 1's entry criteria are therefore met. Its first act on the walking
skeleton should be deletion, not extension — `test/nfr/walking-skeleton.test.ts`
pins it so that stays true.
