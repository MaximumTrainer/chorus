# ADR-0018: A second model provider, and what "no vendor SDK" actually forbids

- **Status:** Accepted
- **Date:** 2026-09-07
- **Requirement:** NFR-2, NFR-1
- **Issue:** #161
- **Amends:** `architecture.md` §9.1. Does not supersede ADR-0005 (recorded in `architecture.md` §5.2); it narrows one sentence written when there was only one provider.

## Context

`architecture.md` §9.2 has always listed Anthropic first among the providers
Chorus supports. Only one existed: the OpenAI-compatible provider, written over
`fetch`. §9.1 explains why, and the explanation is general:

> **One provider speaks the OpenAI-compatible wire format**, over `fetch` rather
> than a vendor SDK — an SDK would be a dependency that reaches exactly one
> endpoint, which is the lock-in ADR-0005's boundary rule exists to prevent.

Read literally, that forbids every vendor SDK anywhere, forever. Read as
written — as the justification for a specific choice about a specific provider —
it says something narrower and more defensible.

Two facts make the narrower reading the intended one. The boundary suite has
always exempted `packages/llm` from the `@anthropic-ai/*` import ban rather than
forbidding it outright (`packages/testing/src/boundaries.ts`). And
`packages/llm/package.json` describes the package, in its own words, as "the
only place a provider SDK or a model name may appear". The architecture
anticipated this; only §9.1's prose did not.

Separately, adding a second provider exposed something that had been true and
invisible. The router resolves `purpose → tier → {provider, model}` and has
always returned both halves. Only the model half was ever acted on: one client
served every call. A workspace could name a provider in `CHORUS_MODEL_TIERS`,
have that name written to `spend_ledger`, and be served by whatever endpoint
happened to be wired in. Nothing failed. The ledger simply recorded the provider
that had been *asked for*.

## Decision

**A vendor SDK may be used inside `packages/llm`, and nowhere else.** The
boundary suite already enforces the second half mechanically; this ADR records
the first half so the prose and the rule agree.

**The OpenAI-compatible provider stays `fetch`-based.** Its argument is
untouched and still correct: one client reaching OpenAI, Azure, Ollama, LM
Studio, vLLM and every self-hosted server is precisely its value, and an SDK
there would collapse it to one vendor. That is what makes NFR-1's "no mandatory
SaaS dependency except the chosen model endpoint" true in practice.

**The Anthropic provider uses `@anthropic-ai/sdk`.** The lock-in argument has
nothing to bite on — a provider for one vendor reaches one vendor by
construction — and what remains is a stream whose framing is easy to get wrong
in ways that do not announce themselves. Usage is split across two frames:
`input_tokens` on `message_start`, `output_tokens` on `message_delta`, the frame
after the last content delta. A hand-rolled client that stops reading at
`content_block_stop` reports half the cost of every call it makes, confidently,
and the spend ledger is wrong in the one place nobody re-checks.

**`ref.provider` becomes load-bearing, through a registry.** `createProviderRegistry`
dispatches each call to the provider its model reference names, and is itself a
`ModelProvider` — so the executor, the turn runner and every future caller stay
unaware that there is more than one, which is the whole of what NFR-2 promises.
An unconfigured provider is refused, naming what *is* configured; it is never
served by whichever client is at hand. A call silently answered by the wrong
provider is billed to the wrong ledger line and reasoned about with the wrong
capabilities, which is the invisible downgrade the router's fallback recording
exists to prevent.

**A `ModelProvider` contract-test kit is the mechanism that keeps this honest.**
It lives in `packages/llm/src/testing/`, asserts behaviour rather than encoding,
and every provider must pass it. It was written against the OpenAI-compatible
provider *first* and passes it unchanged — a kit authored alongside a new
implementation describes that implementation, and would let the new provider
define the contract it is meant to satisfy.

## Consequences

NFR-1 is unaffected. `openai-compatible` remains the default and the only
provider a local profile needs; Anthropic is opt-in, reached by setting
`CHORUS_ANTHROPIC_API_KEY`. A deployment configuring neither is refused at boot
with both variable names in the message.

Anthropic serves no embedding endpoint, so the `embed` tier stays on an
OpenAI-compatible endpoint. The provider refuses `embed` rather than returning
nothing: a misconfigured tier that indexed empty vectors would not fail, it
would make retrieval return confident nonsense.

`@anthropic-ai/sdk` is a new dependency (CLAUDE.md §7 requires an ADR for one).
It is pinned exactly, confined to `packages/llm`, and the boundary suite fails
any import of it elsewhere.

## What is deliberately not decided

Whether a *third* provider gets an SDK or a `fetch` client. The question is
per-provider and the answer follows the same test: does this client reach one
endpoint or many? A single-vendor SDK is admissible; a client that could have
been provider-agnostic and was written against one vendor's SDK is not.

Whether the wire samples in `packages/llm/test/contract/` become recorded
cassettes with a player, as the connectors have. They are hand-written today
because the cases that matter — a truncated stream, an upstream quoting the
credential back — are ones no real endpoint produces on request. A third
provider is the point at which the machinery would pay for itself.
