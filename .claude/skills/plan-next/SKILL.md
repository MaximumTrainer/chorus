---
name: plan-next
description: Pick and set up the next piece of work in Chorus. Use when asked to "progress with the plan", "work through the backlog", "continue with plan implementation", "what's next", or "what is required to unblock WP-x". Reads plan.md's critical path and work packages against the open GitHub issues, names one requirement id, and states the acceptance test before any code is written.
---

# Choosing the next piece of work

The answer to "what next" is never a guess. It is a **requirement id** taken from
`plan.md`, justified by the dependency order, and carrying a GitHub issue with
Given/When/Then acceptance criteria.

## 1. Find where the programme is

```bash
git log --oneline -20                      # what has actually shipped
gh issue list --state open --limit 100     # what remains
gh issue list --state closed --limit 30    # what was closed, and when
```

Read, in this order:

- `plan.md` §3 — the critical path. Work on it beats work off it, always.
- `plan.md` §4 — the phase plans. The current phase's table gives work packages
  (`WP-1.5`) mapping to requirement ids (`TASK-1`) mapping to issues (`#47`).
- `plan.md` §2 — the corrections. Some issues are deliberately re-ordered or
  partially deferred; §2.1's three dependency cycles are each **one** work
  package and must not be started piecemeal.
- The current phase's **exit criteria** checklist — the definition of the phase
  being over, and the honest answer to "how far along are we".

## 2. Choose

Prefer, in order:

1. A red remote build. Nothing else matters while `main` is broken — use `green-main`.
2. An open `priority:must` bug on a shipped requirement, over new scope.
3. The next unblocked item on the critical path (`plan.md` §3).
4. The next item in the current work package, in the order the WP row gives
   (`DOC-1 → DOC-2 → DOC-3, DOC-4, …` means DOC-2 blocks the rest).

Off-critical-path lanes (documents, extension, chat surfaces, navigation,
non-git connectors) are parallelisable — pick one only when the critical path
is blocked, and say that is why.

If a work package is blocked, say **what** blocks it and what would unblock it,
rather than silently picking something else.

## 3. Announce before writing anything

Post, in the reply, before touching a file:

- the **requirement id** and its issue number;
- why it is next (dependency, blocker, or phase exit criterion);
- the **acceptance test** you are about to write — its file, its name
  (`describe('TASK-4 push to tracker')`), and the Given/When/Then it mirrors
  from the issue;
- anything in `architecture.md` the change will contradict, and whether that
  means an edit to it or an ADR under `docs/adr/`.

If no requirement id covers the work, it needs a requirement and an issue before
it needs code — use `backlog-sync` to file it.

Then hand over to `tdd`.

## Vocabulary

Ids are `WS-n`, `NFR-n`, `BRAIN-n`, `INT-n`, `AGENT-n`, `CHAT-n`, `TASK-n`,
`DOC-n`, `CODE-n`, `MCP-n`, `PROTO-n`, `NAV-n`, `SLACK-n`, `EXT-n`, `D-n`
(open decisions, `plan.md` §7). Work packages are `WP-<phase>.<n>`.
