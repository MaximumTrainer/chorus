# ADR-0023: Operational facts are referenced from an external graph, not extracted

- **Status:** Accepted
- **Date:** 2026-11-12
- **Requirement:** BRAIN-11 (#174); shared with INT-11 (#173)

## Context

Chorus's brain extracts entities from signals. An SDLC knowledge graph already
holds operational facts — services, environments, deployments, ownership,
lineage — with provenance from manifests, CODEOWNERS and a change feed. Once
both exist, the two describe the same things and disagree: the extractor reads a
Slack thread that says "checkout depends on payments" and mints a `component`
*checkout*, while the graph holds a `Service` *checkout* with an owner and a
manifest behind it. BRAIN-7 then proposes merging them every night, and the wiki
compiler writes a page that is half-inferred.

Principle 2 (§1) says context is compiled from sources, not curated. When the
source *is* a graph with provenance, the right compilation is a pointer.

## Decision

**An entity may be owned by an external system.** Every entity carries an
`authority`: `brain` (the default) or `external`. An external-authority entity
is a reference — addressed by a parseable `external_uri` (`<scheme>://<type>/<id>`,
e.g. `sdlckg://Service/checkout`) — whose facts are read from the owning system,
not from Chorus's extractor.

The kinds `service`, `environment`, `deployment` and `resource` are **always**
external; a brain-authored one is refused with a typed `AppError`, in the Zod
schema and again at the store, and forbidden by a database CHECK. An existing
kind such as `repo` may be either, so a repository mirrored from the graph and
one Chorus knows from a git host can both exist and resolve to one.

The extractor may **link** to an external entity but never create, merge or
contradict it; self-organisation excludes external entities as merge/split/
contradiction targets; retrieval expands through them; and the wiki compiler
renders them as link blocks rather than generating a page. Those behaviours are
the rest of BRAIN-11's acceptance criteria, built on this schema.

## Consequences

- One identity for "the production environment", `sdlckg://Environment/…`, that a
  brief (CODE-2), a signal (INT-11) and a tool result (MCP-7) all cite.
- No nightly merge war between two graphs about the same repository.
- **Out of scope:** writing back to the external graph (a future sink), and
  federated query across graphs — retrieval reads the brain's copy of the
  references and edges only; on-demand facts come via MCP-7.
- Open decision (§27): whether `component` should be unified with `service` once
  an external graph is connected.
