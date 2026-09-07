# ADR-0017: Three fast checks before a commit, and a coverage floor before a push

- **Status:** Accepted
- **Date:** 2026-09-07
- **Requirement:** NFR-3 (secrets), NFR-12 (developer experience), and architecture.md §23's promise of "coverage thresholds on changed packages"
- **Adds a dependency:** `@vitest/coverage-v8`, which CLAUDE.md §7 says needs an ADR. This is it.

## Context

Two gates existed: `commit-msg` refuses a source change with no documentation
and no stated reason, and `pre-push` runs `pnpm verify`. Nothing looked at the
*content* of a change before it became permanent.

CLAUDE.md §7 forbids "committing a cassette or fixture containing real
credentials", and nothing enforced it. architecture.md §23 promises "coverage
thresholds on changed packages" as a pull-request gate, and nothing measured
coverage at all — the provider was not installed.

## Decision

**Three checks in `pre-commit`, ordered by how hard each failure is to undo.**

1. **Secrets.** A credential in a commit survives `--amend`, stays in the
   reflog, and is in every clone made afterwards. It is the only failure here
   that a later commit cannot fix, so it is checked first and it blocks.
2. **Lint**, on the staged files only.
3. **The unit tests related to the staged code**, resolved through the import
   graph.

**A coverage floor in `verify`**, which `pre-push` and CI already run.

## Why the secret patterns are copied rather than imported

The scanner is plain JavaScript with no workspace imports. A commit hook runs
before anything is built, and sometimes in a checkout where `pnpm install` has
never been run; a hook that needs a loader or a compiled package fails in the
situation it exists for.

The cost is a second copy of `SECRET_PATTERNS`, which would drift — and drift
silently in the worse direction, the scanner quietly ceasing to recognise a
shape the product still scrubs. So `test/nfr/pre-commit.test.ts` compares the
two lists by source and fails if they differ. One definition, enforced rather
than assumed.

The patterns are deliberately over-broad, and the reasoning carries over from
redaction: a false positive costs somebody a moment, a false negative is a live
credential in a permanent record. The hook reports the **file and line and the
pattern**, never the matched text — a gate that prints the credential it caught
has leaked it a second time, into a terminal, a CI log and possibly a
screenshot.

## Why coverage is not in the commit hook

It was asked for there, and the measurement argues against it. The same commit
reports:

| Projects measured | Lines |
|---|---|
| unit + integration + contract | 50.7% |
| …plus acceptance | **89.5%** |

Most of `apps/api` is exercised through its public entry points, which is
exactly what CLAUDE.md §2 asks for. A commit hook cannot run the acceptance
suite — it needs Postgres and takes minutes — so a coverage check there would
report half the truth and refuse commits for code that is thoroughly tested.
Worse, it would teach people that the number is noise, which is how a gate
stops being read.

So coverage runs where the full suite already runs. `verify` now runs the four
test projects **once, with coverage**, rather than running them uncovered and
then again to measure — the floor costs the gate no extra suite.

## The floor is a floor, not a target

CLAUDE.md §7 lists "adding tests afterwards to reach a coverage number" as an
anti-pattern, and it is right: a number to hit produces tests asserting what the
code already does. That is a real tension with architecture.md §23's promise,
and it is resolved by what the threshold is *for*.

It is not there to make anybody write more tests. It is there to catch the case
where a change adds a module that nothing exercises at all — which the outside-in
method should already prevent, and which this notices when it does not.

The numbers are measured, not chosen: 85% lines and statements, 78% branches,
90% functions, a few points under where the repository actually sits. Raise them
when the measured figure rises; do not chase them.

## Consequences

- A credential-shaped string cannot be committed without `--no-verify`, which is
  recorded in the reflog as a deliberate act.
- Commits are slower by the cost of linting a few files and running the unit
  tests that touch them — seconds, and the hook is written to keep it that way.
  `.githooks/commit-msg` records why that matters: a gate people skip because it
  is slow is a gate that is not run.
- `verify` now fails when coverage drops below the floor. Someone deleting a
  test suite will hear about it from the gate rather than from a later incident.
- Fixtures that *look* like credentials must be obviously fake. The redaction
  suite already keeps its examples that way.
