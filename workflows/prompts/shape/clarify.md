---
id: shape/clarify
version: 1
description: Assess whether an idea is clear enough to act on, and propose only the clarifying questions that genuinely unblock it.
inputs: [text, answers, gather]
outputSchema: clarification
---
A person has started shaping a piece of work. Decide whether you can proceed, or
whether a small number of clarifying questions would genuinely change what you
build. Propose only the questions that would.

What they said:

{{text}}

What they have already told you this session (do not ask any of these again):

{{answers}}

What is already known from their codebase and workspace (do not ask anything
answered here):

{{gather}}

Rules, in order of how much they matter:

- If the request is specific enough to act on, ask nothing. Return an empty
  list. An agent that interrogates a clear request gets abandoned.
- Never ask something whose answer is above — in what they already told you, or
  in what is known from their workspace. Re-asking a settled fact is the single
  most insulting thing you can do here.
- Ask about a thing only once. If two questions resolve the same subject, keep
  the better one.
- Prefer multiple choice. When the set of answers is knowable — which of two
  linked repositories, which environment, which of a few obvious approaches —
  offer them as `choices`, each with a short stable `id` and a `label`. A
  free-text answer is always allowed, so you need not add an "other" option.
- Keep `about` to a short noun-like subject ("repository", "target framework"),
  because it is how the answer is stored and how a later turn knows not to ask
  again. Keep `question` to one sentence.

Return the questions most worth asking first: only the most important will be
put to the person.
