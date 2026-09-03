# The walking skeleton — DELETE ME IN PHASE 1

Everything in this directory is **deliberately throwaway**. It exists to satisfy
one Phase 0 exit criterion:

> A user signs up, creates a workspace, connects a repository, and asks a
> question about the code — receiving a streamed answer citing real files at a
> real commit.

`plan.md` §2.5 explains why it exists and says the quiet part out loud:

> Its purpose is to prove every layer connects, and it is expected to be
> replaced by the real implementations in Phase 1. Label the code as such; **the
> temptation to keep it is the failure mode.**

## What this is not

It is not the agent runtime (AGENT-1): there is no workflow engine, no step
durability, no checkpoints, no tool calls, no resumption. It is not retrieval
(BRAIN-4): there is no hybrid search, no graph expansion, no permission
predicate beyond the tenancy boundary, and no signals — code chunks only. It is
not chat (CHAT-2): there are no sessions, no message history, no rich content,
no artefacts.

Each of those is a Phase 1 requirement with its own acceptance criteria, and
each will be built properly. Nothing here should be extended; if you find
yourself adding a feature to this directory, the feature belongs to the real
implementation instead.

## What replaces it

| Here | Replaced by |
|---|---|
| `ask.ts` — one retrieval call | BRAIN-4, WP-1.4 |
| `ask.ts` — one model call, streamed | AGENT-1, WP-1.1 |
| `POST /workspaces/:id/ask` | CHAT-2's sessions and messages, WP-1.7 |

## How deletion is enforced

`test/nfr/walking-skeleton.test.ts` pins this directory's contents, so it cannot
grow quietly, and Phase 1's exit criteria require the whole thing to be gone.

The acceptance test that drove it — `walking-skeleton.test.ts` — is **not**
throwaway. The same journey must keep passing against the real implementations,
which is precisely what makes deleting this safe: the criterion outlives the
code that first satisfied it.
