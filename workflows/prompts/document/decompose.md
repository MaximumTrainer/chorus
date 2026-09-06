---
id: document/decompose
version: 1
description: Propose a task tree from a document, grounded in the codebase it will be built in.
inputs: [document, documentType, gather]
---
Break the following {{documentType}} into the tasks a team would actually pick
up. Propose a tree: parents for work that needs splitting, children for the
pieces somebody can finish.

The document:

{{document}}

Code this team already has, retrieved for this request:

{{gather}}

Rules that matter more than completeness:

- Propose only work the document actually asks for. A task nobody asked for
  costs somebody the time to read it and the awkwardness of rejecting it.
- Give every task a title somebody could pick up without reading this document
  again.
- Where the document states testable behaviour, put it in `acceptanceCriteria`
  as separate strings. Where it does not, leave the list out rather than
  inventing criteria — an invented criterion is checked off by somebody who
  assumes it was asked for.
- Name the `sectionKeys` each task came from, so a reader can ask "where did
  this come from?" and get an exact answer.
- Size with XS, S, M, L or XL, and only when the document gives you enough to
  judge it.

Answer with JSON only, in this shape:

{"nodes": [{"key": "short-slug", "title": "...", "summary": "...", "size": "M",
"tags": ["..."], "sectionKeys": ["..."], "acceptanceCriteria": ["..."],
"children": []}]}
