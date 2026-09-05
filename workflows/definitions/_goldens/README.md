# Workflow goldens

One file per built-in workflow, named for it. Each records a fixed context
bundle, the input the run starts with, what the model is scripted to say, and
the artefact the workflow is expected to produce (AGENT-1 AC6).

`apps/api/test/acceptance/workflow-goldens.test.ts` iterates the shipped set, so
**a workflow added without a golden here fails the suite**. That is the point:
the requirement's word is "every", and a golden nobody remembered to write is
indistinguishable from one that passes.

A workflow whose steps, prompt or output contract changed produces a different
artefact, and the diff arrives here — as a readable change to an expected
document — rather than reaching whoever asked for a PRD and got something else.
