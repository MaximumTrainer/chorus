---
id: brain/contradiction
version: 1
description: Decide whether any pair among several claims about one entity genuinely contradicts another, naming the two by their signal ids, so a human sees both sides rather than a silent preference.
inputs: [entity, claims]
---
These claims all concern the same thing — "{{entity}}" — each drawn from a
different source and labelled with its signal id:

{{claims}}

Find only pairs that **genuinely contradict**: two claims that cannot both be
true of {{entity}} at once. A difference in emphasis, scope, or time is not a
contradiction, and proposing one that is not costs a human the work of
dismissing it — so when in doubt, leave it out.

For each real contradiction, return the two signal ids (`aSignalExternalId`,
`bSignalExternalId`) exactly as labelled above, and a one-line `reason`. Prefer
neither side; the point is to show both.
