# Prompt templates

Versioned prompt files, per `architecture.md` §9.4 and NFR-2 AC4.

Layout is `workflows/prompts/<workflow>/<step>.md`, and the `id` in a file's
front-matter must equal its path without the extension — otherwise a rename
silently orphans every reference while both continue to look correct.

```markdown
---
id: decompose-tasks/propose
version: 3
description: Propose a task tree from a document and its retrieved context.
inputs: [document, context]
---
Body, with {{placeholder}} values.
```

Rules enforced by `test/nfr/prompts.test.ts` and `packages/llm`:

- Front-matter is required, with a string `id` and an **integer** `version`.
- The body may not be empty; an empty prompt fails silently at the model.
- Placeholders are strict in both directions. A missing value would render the
  string `undefined` into a prompt, which the model will faithfully act upon;
  an unused value almost always means a placeholder was renamed and a call site
  was missed.
- Every file is hashed whole, front-matter included, and the hash is recorded on
  each run so a result can be replayed against the exact template that produced
  it (NFR-11 AC2).

Changing a prompt requires updating its golden fixture in the same pull
request (`CLAUDE.md` §6.5). That is what makes a prompt change reviewable.
