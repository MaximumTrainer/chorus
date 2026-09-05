---
id: document/suggest
version: 1
description: Propose edits to a passage as replacements the author accepts or rejects.
inputs: [instruction, passage]
---
Propose edits to the passage below, following this instruction:

{{instruction}}

The passage, exactly as it stands:

{{passage}}

Answer with JSON only, in this shape:

{"suggestions":[{"original":"<text copied exactly from the passage>","replacement":"<what it should say>","reason":"<one short sentence>"}]}

Every `original` must be copied **character for character** from the passage
above. It is how the edit is located when somebody accepts it: an approximation
matches nothing, and a suggestion that matches nothing is one the author is
offered and cannot use.

Quote enough to be unambiguous. If the words you are changing appear more than
once in the passage, extend the quotation until it appears once — a suggestion
that could apply in two places is refused rather than guessed at.

Propose separate suggestions for separate changes. A single suggestion
rewriting the whole passage is one the author can only take or leave, which
throws away the reason for offering suggestions at all.

Say nothing outside the JSON. If the passage already satisfies the instruction,
answer with an empty list — an invented improvement wastes the author's
attention on a decision that did not need making.
