# ADR-0015: Tiers are defined by capability and cost band, not by model; defaults ship as configuration

- **Status:** Accepted
- **Date:** 2026-09-03
- **Decision:** D-5, deadline end of Phase 0 (`plan.md` §7)
- **Requirement:** NFR-2, NFR-8
- **Supersedes:** nothing. Resolves open decision 5 in `architecture.md` §27, on narrower terms than it asked for — see "What is deliberately not decided".

## Context

`architecture.md` §9 routes every model call by *purpose* — `chat`, `classify`,
`extract`, `draft`, `decompose`, `code`, `embed`, `summarise` — onto a *tier* —
`fast`, `balanced`, `strong` — and then onto a concrete provider and model from
workspace configuration. No caller names a model; the dependency-boundary suite
enforces that mechanically.

`plan.md` §7 puts this decision at the end of Phase 0 because it is "every
workflow's cost and quality baseline", and the cost of deciding late is
"re-tuning every prompt".

§27 says the defaults should be "decided against an evaluation set covering
structure proposals, pointer accuracy and triage classification". **That
evaluation set does not exist.** Building it needs CHAT-5's structure proposals,
TASK-3's pointers and the triage workflow — all Phase 1 or later. Deciding a
quality ranking now would mean inventing evidence, and a default justified by
nothing is worse than one justified by a stated principle, because it looks
measured.

So the decision that is genuinely due at the end of Phase 0 is a different one:
**what a tier means, what happens when configuration is absent, and what ships
in the box.**

## Decision

**A tier is a capability-and-cost contract, not a model.** Each tier is defined
by what a caller may rely on, and any model satisfying it may serve it:

| Tier | May rely on | Intended for |
|---|---|---|
| `fast` | structured output, ≥32k context | classification, triage, extraction — high volume, low ambiguity |
| `balanced` | structured output, tool calling, streaming, ≥128k context | chat, drafting, summarising — the default for anything a person waits on |
| `strong` | structured output, tool calling, streaming, ≥200k context | decomposition, code, structure proposals — where a mistake is expensive to undo |

The router already matches a request's `CapabilityRequirements` against a
candidate's `ModelCapabilities` and records every fallback in the run trace
(NFR-2 AC3). This ADR makes the tiers the *stable* interface: a workspace
re-pointing `strong` at a different model must not require a code change or a
prompt change, and a purpose moving between tiers is a configuration decision.

**Purpose-to-tier defaults ship in `packages/llm`** and are overridable per
workspace:

```
classify, extract        → fast
chat, draft, summarise   → balanced
decompose, code          → strong
embed                    → (its own embedding model, not a chat tier)
```

`decompose` and `code` sit at `strong` deliberately. Both produce artefacts a
person then works from — a task tree, a pull request — so an error is not a bad
sentence, it is an afternoon.

**No concrete model is named in this repository's source.** Defaults are shipped
as *configuration*, not code: a deployment supplies its tier→model mapping
through `CHORUS_MODEL_TIERS`, and the reference configuration in `deploy/` names
models for a cloud and a local profile. This is what keeps the boundary suite's
"no model name outside `packages/llm`" rule meaningful, and it is why a model
deprecation is an ops change rather than a release.

**A tier with no configured candidate fails at boot**, loudly, naming the tier
(`ConfigurationError`). It does not silently fall back to another tier: a
`strong` request quietly served by `fast` is exactly the invisible quality
regression the router's fallback recording exists to prevent, and boot is the
cheapest moment to find it.

**Absent configuration is a different case from wrong configuration**, and is
handled differently. A half-configured deployment — some tiers set, one missing
or undersized — is a mistake, and refusing to start is right. A deployment with
*no* model configuration at all is not a mistake: it is `docker compose up` on a
fresh host, which NFR-1 requires to reach a working system. A process that
refused to start there would leave an operator with a crash-looping container
instead of a system they can log into and configure. So a process validates
eagerly when `CHORUS_MODEL_TIERS` is present and defers when it is absent,
warning at boot and failing the individual unit of work with the missing setting
named. The distinction is real: one is "you got this wrong", the other is "you
have not done this yet".

## Consequences

**What this buys.** Prompts are written against a tier's guarantees, so
re-pointing a tier does not re-tune a prompt — which is the cost `plan.md` names.
Local-only deployments are a configuration profile rather than a special case.
And a model's deprecation, which happens on the provider's schedule and not
ours, never reaches our source tree.

**What it costs.** A self-hoster must supply a tier mapping to start, which is
one more required configuration value at first run. Mitigated by shipping
reference profiles and by failing at boot with the tier named, rather than at
the first chat with a stack trace.

**What is deliberately not decided.** *Which* model is best per tier. That needs
the evaluation set §27 asks for, and the honest position is that we do not have
one yet. This is entered in the debt register with a Phase 1 target: build the
eval set alongside CHAT-5 and TASK-3, then publish a recommended profile per
tier with its measured results. Until then the reference profiles are stated as
**reasonable starting points, not benchmarked recommendations**, and the
documentation says so in those words.

**The trigger to revisit.** The first measured eval run — which should either
confirm the reference profiles or replace them, and either way turns this ADR's
open half into a closed one.
