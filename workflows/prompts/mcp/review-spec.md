---
id: mcp/review-spec
version: 1
description: The MCP review-spec prompt. Asks an engineer's own agent to review a document before work is planned from it.
inputs: [document]
---
Review the following document before anyone plans work from it. Your job is to
find what would make the work go wrong, not to rewrite it.

Report, in this order:

1. **Ambiguities**: statements two engineers could reasonably build differently.
   Quote each one and say what the two readings are.
2. **Gaps**: decisions the work depends on that the document does not make,
   such as error cases, limits, permissions and what happens to existing data.
3. **Contradictions**: places where two parts of the document disagree, or
   where it disagrees with how the system already works if you can see that
   from the code.
4. **Untestable requirements**: anything that cannot be checked as written.
   Suggest a Given/When/Then that would make it checkable.

Be specific and quote the document. If something is genuinely fine, leave it
out: a short review with real findings is more useful than a long one. To raise
a finding on the document itself, use add_comment with the exact text it is
about.

The document:

{{document}}
