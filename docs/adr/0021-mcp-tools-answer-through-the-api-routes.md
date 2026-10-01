# ADR-0021: MCP tools are answered by the API route that serves the same operation

- **Status:** Accepted
- **Date:** 2026-09-30
- **Requirement:** MCP-2 (#86); shapes MCP-3 (#87) and MCP-5 (#89)
- **Supersedes:** nothing. Refines ADR-0007, which maps MCP tools one-to-one onto the service layer, by naming the layer.

## Context

ADR-0007 makes MCP the primary machine-facing contract and says each tool
maps one-to-one onto the service layer the web UI uses. MCP-2 AC1 then asks
for the same data as the API for the same user, and MCP-5 AC1 asks for the
permitted set over MCP to be *identical* to the API's, for every tool, role
and scope.

The service layer does not decide permissions. The route table does, as data
(WS-4 AC4): each route declares a role and scopes, a team in its path applies
the team override, and a refusal by a member is written to the audit log. A
tool that called a service directly would need all of that restated per tool,
and MCP-5 exists because two statements of the same rule drift.

## Decision

**A tool call is answered by dispatching a request to the API route that
serves the same operation, in-process, with the caller's own credential.**
`get_task` is `GET /workspaces/{id}/tasks/{taskId}`; `list_tasks` is the team's
task list. The route authorises the call exactly as it authorises the web UI
and scripts, and its response is the tool's data.

The credential is taken from the request carrying each call, not from the one
that opened the session. A token revoked mid-session stops working at its next
call (MCP-5 AC5).

What the MCP layer adds is only what an agent needs and a browser does not:

- **Bounds (MCP-2 AC2).** A list is served a page at a time behind an opaque
  cursor. Any result longer than the configured limit (48,000 characters by
  default) is cut, and its last line names the tool and the `offset` to pass
  to read on.
- **Actionable errors (AC5).** A refusal becomes a tool result with
  `isError: true` that says whether the id, the arguments, the token's scope or
  the caller's role is the problem, and what to do instead.
- **Not-found is composed, not relayed (AC6).** The not-found message is built
  from what the agent sent. It never passes on the route's wording, so an id
  from another workspace and an id that never existed read the same.

Tool names, input schemas and descriptions are wire shapes and live in
`packages/core` (`mcp-tools.ts`), with the input schemas snapshotted.

## Alternatives considered

- **Call the service layer directly, with a permission declaration per
  tool.** It saves an in-process request per call. The cost is a second
  statement of every route's role and scope, the team override and the denial
  audit, which is exactly the drift MCP-5 guards against. The parity suite
  could catch that drift, but here the drift cannot happen at all.
- **Call the routes over the network.** It gives the same parity, but it adds
  a hop, a port and a failure mode for no gain over `app.fetch`.

## Consequences

- A tool can only offer what a route offers. When MCP-2's brain-backed tools
  (`search`, `get_entity`, `get_wiki_page`, `get_repo_context`) arrive, they
  need routes first. That is ADR-0007's rule applied in the other direction:
  a capability MCP has and the API lacks is a bug too.
- The API's lists are unpaginated today, so a tool pages over the full list
  the route returns. When lists gain keyset pagination the cursor stays
  opaque, so agents are unaffected.
- A refusal made through MCP is audited as the route it reached, which is what
  an administrator reading the trail needs to know. Recording that the call
  came through MCP, with the client's name, is MCP-5 AC3.
