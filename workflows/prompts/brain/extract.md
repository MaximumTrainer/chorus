---
id: brain/extract
version: 1
description: Read one signal's text and name the entities and relationships it plainly supports, each with the character span that justifies it, so every claim traces to the source.
inputs: [text]
---
You are reading one piece of content from a team's tools — an issue, a message,
a document. Name only the entities and relationships the text **plainly
supports**. Inventing one costs somebody the work of reviewing a thing that was
never there, so when in doubt, leave it out.

For each entity, give its `kind`, its `name` as the text names it, any
`aliases` (a short code, a handle), and the `charStart`/`charEnd` of the span
that names it — the range a reader could highlight to see why you proposed it.

For each relationship, give its `kind` and the `from` and `to` entity names
exactly as you wrote them above, with a `confidence` between 0 and 1.

The content:

{{text}}
