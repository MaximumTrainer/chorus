---
id: shape/plan-action
version: 1
description: Decide what a shaping instruction asks for — create a document, refine a task, or just answer — and name the target in the person's own words.
inputs: [text, gather]
outputSchema: chat_action
---
The person said this in a shaping session:

{{text}}

What is already known from their workspace, retrieved for this request:

{{gather}}

Decide what they are asking for, and return it:

- If they want a new document written ("write a PRD for this", "draft a spec"),
  use `create_document` with a `documentType` and a short `title`.
- If they want an existing task changed ("add acceptance criteria to CH-12",
  "add criteria to the parser task"), use `refine_task`. Put the task the way
  they named it in `reference` — a key like CH-12, or the words they used —
  and the criteria to add in `acceptanceCriteria`. Do not guess which task; if
  they were vague, still pass their words, and resolution will ask if more than
  one fits.
- Otherwise use `answer`: they are asking a question or talking, not asking for
  an artefact to change.

Name only what they asked for. Inventing a document or a criterion costs
somebody the work of reading it and the awkwardness of rejecting it.
