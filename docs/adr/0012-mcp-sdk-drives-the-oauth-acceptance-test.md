# ADR-0012: The MCP SDK is a test dependency, and it is what drives the OAuth acceptance test

- **Status:** Accepted
- **Date:** 2026-09-02
- **Requirement:** WS-5 (AC3), and ahead of MCP-1
- **Supersedes:** nothing. Refines the stack decision in `architecture.md` §5.1.

## Context

WS-5 requires Chorus to *be* an OAuth 2.1 authorization server — RFC 8414
metadata, RFC 7591 dynamic client registration, RFC 7636 PKCE, refresh rotation
— because MCP's authorization specification requires all four of a server it
will talk to.

The requirement is explicit about how this must be proved: *"the metadata
document must be correct enough for a real MCP client to bootstrap unattended —
test against a genuine client library, not a hand-rolled request."*

That instruction is doing real work. An authorization server is a piece of
protocol, and protocol bugs are almost never *behavioural*: they are a missing
field in a metadata document, a parameter named the way we would have named it
rather than the way the RFC does, an error body a library cannot parse. A
hand-written test request agrees with the implementation by construction,
because the same person wrote both. It proves the server agrees with the test
author, which is exactly the thing not in question.

`better-auth@1.7.2`, already present for WS-1, ships no OIDC-provider or MCP
plugin in this release, so there was no option that avoided writing the server
ourselves. That is consistent with `architecture.md` §5.1, which already says
Better Auth handles identity *"plus a platform-issued OAuth 2.1 server for MCP
and the extension"`.

## Decision

Add **`@modelcontextprotocol/sdk`** as a **devDependency of `apps/api`**, and
drive the WS-5 acceptance test with its client-side OAuth functions —
`discoverAuthorizationServerMetadata`, `registerClient`, `startAuthorization`,
`exchangeAuthorization`, `refreshAuthorization`.

CLAUDE.md §7 makes a new dependency an ADR-level decision, which is why this
document exists rather than a line in a lockfile.

Three things make this the right dependency rather than a convenient one:

1. **It is the actual consumer.** WS-5 exists so that MCP-1 and EXT-1 can
   authenticate. Testing against the library those will use is testing against
   the real client, not a proxy for one. Every step of the flow in
   `oauth-server.test.ts` is the SDK's code; ours only answers it.
2. **It arrives in Phase 1 regardless.** WP-1.11 builds the MCP server with this
   SDK. Taking it now as a test dependency does not add a dependency to the
   product — it moves an already-planned one earlier, in the narrower of the two
   roles.
3. **It stays out of the shipped artefact.** It is a devDependency of one app,
   used only under `test/`. The dependency-boundary suite still governs
   `src/`, and no production code imports it.

Its functions accept an injected `fetchFn`, so the test drives the in-process
Hono app with no socket, no port and no network. The library's behaviour stays
genuine while the test stays hermetic and parallel-safe.

## Consequences

**What this buys.** The metadata document is now checked by something that did
not write it. Two of the ten acceptance cases failed on the first run for
reasons a hand-rolled request would have been written not to notice.

**What it costs.** The SDK's client is now load-bearing for our test suite: an
upgrade that changes its discovery order or its PKCE defaults will show up as a
test failure in WS-5 rather than in MCP work. That is acceptable, and arguably
the point — if the real client's expectations move, we want to find out from a
red test rather than from a client that cannot connect.

**What it does not decide.** Whether the MCP *server* uses this SDK is MCP-1's
decision, not this one. This ADR only makes the client available to tests.

**The escape hatch.** If the SDK ever becomes an unreasonable test dependency,
the replacement is another genuine client library — not a hand-rolled request.
The requirement's instruction is about independence from the implementation, and
that is what any replacement has to preserve.
