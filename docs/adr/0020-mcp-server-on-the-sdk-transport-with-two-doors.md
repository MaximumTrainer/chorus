# ADR-0020: The MCP server runs on the SDK's transport, with sessions bound to a user and a workspace, behind two doors

- **Status:** Accepted
- **Date:** 2026-09-30
- **Requirement:** MCP-1 (#85)
- **Supersedes:** nothing. Extends ADR-0012, which made the SDK a test dependency and left the server's use of it to MCP-1.

## Context

MCP-1 mounts an MCP server over Streamable HTTP, authenticated per the MCP
authorization specification and also by personal API tokens. `architecture.md`
§14 already says the server is "built on the official TypeScript MCP SDK" and
mounted at `/mcp`. Three things were left open:

1. Whether the SDK becomes a runtime dependency of `apps/api` (CLAUDE.md §7
   makes a new dependency an ADR-level decision; ADR-0012 covered tests only).
2. How a session, which the SDK knows only as an id, is tied to a caller.
3. How a personal API token reaches `/mcp`. An OAuth access token names the
   workspace it was granted for; a personal token does not, so `/mcp` alone
   cannot tell which workspace a script means.

## Decision

**The SDK is a runtime dependency of `apps/api`.** The server uses its
`Server` and `WebStandardStreamableHTTPServerTransport`, which takes a fetch
`Request` and returns a `Response`, so it sits inside a Hono handler with no
Node-specific adapter. Version negotiation, JSON-RPC framing and the header
rules are the SDK's. Those are exactly the parts a hand-written server gets
subtly wrong in ways only a real client notices.

**A session is bound to the user and the workspace that opened it.** The
endpoint keeps a map from session id to transport and owner. A request that
presents a session id with any other owner is answered 404, the same as an id
that does not exist, because confirming that an id is live is itself a leak.
Sessions idle past a timeout (30 minutes by default) are closed, swept on each
request against an injected clock rather than by a timer.

**Two doors to one server.**

- `/mcp` accepts OAuth access tokens. It reads the workspace from the token and
  hands the request to the workspace door. It performs no authorisation of its
  own.
- `/workspaces/{workspaceId}/mcp` accepts either credential and is authorised by
  the same route middleware as every other route: role `member`, no scope,
  refusals audited.

Each tool will declare its own role and scopes (MCP-5), as each HTTP route
does, so connecting grants nothing by itself.

Both doors publish RFC 9728 protected-resource metadata under
`/.well-known/oauth-protected-resource/...`, and a 401 on either carries
`WWW-Authenticate: Bearer resource_metadata=...`. That header is how a client
that has never seen the server finds the authorization server.

**No server stream yet.** `GET` answers 405, which the specification allows and
clients handle. Nothing sends server-initiated messages until tools exist whose
list can change. Replies are JSON rather than SSE for the same reason.

## Alternatives considered

- **One `/mcp` URL plus an `X-Chorus-Workspace` header for personal tokens.**
  It keeps one address, but it adds a second way of naming a workspace that
  only this endpoint understands. It also leaves `/mcp` authorising callers
  itself, which is a second implementation of WS-4.
- **Only `/workspaces/{workspaceId}/mcp`.** It changes the documented address,
  and the OAuth consent screen lets the granter choose a workspace that may not
  match the URL.
- **Minting personal tokens with the workspace inside them, as OAuth tokens
  are.** It would change the format of tokens people already hold.

## Consequences

- Sessions live in the API process's memory. With more than one API machine,
  a request routed to a machine that did not open the session gets 404, and the
  client re-initialises (which the specification requires it to handle). The
  Fly deployment runs one API machine today. Scaling out wants sticky routing
  on `mcp-session-id` or a shared session store, and that is a decision for
  when it is needed.
- The SDK is now load-bearing in production as well as in tests. An upgrade
  that changes its transport's behaviour will show in the MCP-1 acceptance
  suite, which drives the same SDK's client against this server.
- Access tokens are not audience-bound (RFC 8707). A token names its workspace
  and its scopes, and both doors check both. Binding tokens to the `resource`
  a client names is left for when there is a second resource server to confuse
  them with.
