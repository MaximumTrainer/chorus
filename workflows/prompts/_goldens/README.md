# Prompt goldens

One rendered sample per prompt, checked in. `CLAUDE.md` §6.5 requires a prompt
change to update its golden in the same pull request, and this is what makes
that requirement mean something: the diff shows a reviewer exactly what the
model will now be asked, rather than a changed hash.

`inputs.json` holds the sample values each prompt is rendered with. Keep them
representative — a golden rendered with empty strings hides the shape of the
real prompt, which is the thing under review.

The directory is `_`-prefixed so the prompt loader skips it: these are fixtures,
not prompts.
