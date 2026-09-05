---
name: backlog-sync
description: Reconcile the GitHub backlog with what has actually shipped. Use when asked to "close issues once the build is green", "create issues for anything incomplete", "what's left", or after finishing a requirement. Closes issues proven by a green remote build, and files precise issues for the parts deliberately left out.
---

# Keeping the backlog honest

The issue tracker is the requirement catalogue: one issue per requirement id,
carrying its full text, Given/When/Then acceptance criteria and an outside-in
test plan. It is only useful while it matches reality.

## Closing an issue

Close only when **all** of these hold:

1. Every acceptance criterion in the issue is proven by a test that carries the
   requirement id — check with `pnpm test --grep DOC-5` and by reading the
   criteria one by one, not by reading the code.
2. The work is on remote `main`: `git rev-list --left-right --count origin/main...main`
   prints `0	0`.
3. The remote build for that commit is green:
   `gh run list --branch main --limit 3`.

Close with the evidence, so the claim can be checked later:

```bash
gh issue close 40 --comment "DOC-5 shipped in 881f0a6, CI run 1234567890 green.
AC1–AC3 proven by packages/collab/test/integration/versions.test.ts and
apps/api/test/acceptance/versions.test.ts."
```

**Partly done is not done.** If some criteria are met, leave the issue open,
comment on which are proven and which are not, and file the remainder below.

## Filing what is incomplete

Anything deliberately left out gets an issue before it is forgotten — that is
the point of the "Deliberately left out" line in the commit message.

A useful issue states:

- the requirement id and the specific acceptance criterion (`DOC-7 AC3`);
- the observed behaviour or the gap, concretely;
- why it was left (a decision to make, a dependency, a cost) — and if it is a
  decision, say that it wants an ADR under `docs/adr/`;
- what "done" would be, as a test that could be written.

```bash
gh issue create \
  --title "DOC-7 AC3 — PDF export needs a renderer in the worker image" \
  --label "priority:should,module:doc" \
  --body "..."
```

Match the existing label vocabulary: `type:requirement`, `bug`,
`documentation`, `priority:must|should|could`, `module:<area>`.

## Filing a new requirement

Work with no requirement id needs a requirement and an issue **before** it needs
code (`CLAUDE.md` §3). Write the acceptance criteria in Given/When/Then, add the
id to `architecture.md` §26, and place it in a `plan.md` work package — a
requirement nobody scheduled is a requirement nobody builds.

## A periodic sweep

```bash
gh issue list --state open --limit 100
git log --oneline -40
```

Look for: issues whose requirement the log says shipped; issues whose text no
longer matches `architecture.md`; placeholders that were never fleshed out; and
phase exit criteria in `plan.md` §4 with no issue behind them. Report the
discrepancies rather than silently closing or opening things in bulk.
