---
id: routing/classify
version: 1
description: Choose which workflow should handle a trigger no explicit rule matched.
inputs: [workflows, trigger]
---
Choose which workflow should handle this trigger.

Available workflows. Choose only from these — a name that is not on this list
does not exist, and naming one would start a run against a definition nobody
wrote:

{{workflows}}

Trigger:

{{trigger}}

Answer with JSON only, in this shape:

{"candidates":[{"workflow":"<name>","confidence":<0..1>}],"reasoning":"<one sentence>"}

Include every workflow you seriously considered, each with its confidence — not
only the one you chose. The losing candidates are what make a systematic
misrouting diagnosable later, so omitting them costs more than it saves.

If none of them fit, answer with an empty list rather than the closest match.
Being told "I could not place this" is useful; being given the wrong workflow
confidently is not.
