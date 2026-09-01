# Contributing to Chorus

Read [`CLAUDE.md`](CLAUDE.md) first. It is not advisory: Chorus is built **outside-in and test-first**, and a pull request whose implementation was not preceded by a failing test is not accepted.

Then read [`architecture.md`](architecture.md) for the subsystem you are touching, and [`plan.md`](plan.md) for where it sits in the build order.

## Quick start

Requires Node 22+, [pnpm](https://pnpm.io) and Docker.

<!-- quick-start -->
```bash
pnpm install
pnpm verify
```
<!-- /quick-start -->

`pnpm install` also points git at `.githooks`, so `pnpm verify` runs automatically before every push. That safeguard exists because a commit was once pushed with a failing gate: it had been run, but its exit code was not read.

`pnpm verify` runs exactly what CI runs — typecheck, lint, the unit/integration/contract suites, and the non-functional suites. If it passes locally and fails in CI, that divergence is itself a bug (NFR-12 AC4).

To bring up the reference infrastructure:

```bash
docker compose -f deploy/docker-compose.yml up
```

## Finding work

Every change traces to a requirement id (`WS-1`, `BRAIN-4`, `INT-8`, `NFR-3`, …). The [issue tracker](https://github.com/MaximumTrainer/chorus/issues) holds one issue per requirement, carrying its full text, Given/When/Then acceptance criteria and an ordered outside-in test plan. `plan.md` §4 says which work package is next.

If no requirement covers what you want to do, the work needs a requirement and an issue before it needs code.

## Making a change

1. **Name the requirement.** Branch as `<req-id>/<slug>`, e.g. `task-4/tracker-status-mirror`.
2. **Write the acceptance test first**, with the requirement id in its name, and run it. It must fail *for the right reason* — the missing behaviour, not a typo.
3. **Work inwards**: acceptance → integration → unit → minimal implementation → refactor.
4. **Satisfy the cross-cutting rules** in `CLAUDE.md` §6 — tenancy, permissions, audit, checkpoints, sandboxes. These are the ones most costly to get wrong and least visible when broken.
5. **Check the definition of done** in `CLAUDE.md` §8, all of it.

## Test layers

| Layer | Location | Command |
|---|---|---|
| Unit | co-located `*.test.ts` | `pnpm test` |
| Integration | `<package>/test/integration/**` | `pnpm test` |
| Contract | `<package>/test/contract/**` | `pnpm test` |
| Acceptance | `apps/*/test/acceptance/**` | `pnpm test:acceptance` |
| Non-functional | `test/nfr/**` | `pnpm test:nfr` |

Everything proving one requirement is reachable with `pnpm test --grep TASK-4`. That is why the id is mandatory in the test name.

## Commits and pull requests

- Conventional Commits, with the requirement id in the body.
- Sign off with the DCO: `git commit -s`.
- The pull request states which test proves the requirement, and what was deliberately left out.
- If your change alters a decision recorded in `architecture.md`, update it — or add an ADR under `docs/adr/` — in the same pull request. Silent divergence is the one unrecoverable mistake.

## Extension points

These are designed for contribution without touching core, each with a contract and a fixture-based test kit:

- **Connectors** — `packages/connectors` (INT-7)
- **Workflows** — `workflows/` (AGENT-8)
- **Coding adapters** — `packages/coding` (CODE-3)
- **Chat surfaces** — `apps/chat-surfaces` (SLACK-5, TEAMS-1)

## Licence

Apache-2.0. By contributing you certify the [Developer Certificate of Origin](https://developercertificate.org/).
