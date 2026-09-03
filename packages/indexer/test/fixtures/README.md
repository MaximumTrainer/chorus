# Framework fixture repositories

One per framework the route map supports (BRAIN-2 AC3). The issue's note is the
reason these exist as directories rather than as string literals in a test:

> The route map is the least portable part. Treat each framework as a strategy
> with its own fixture repository.

Each is a miniature but *real* repository — a manifest with real dependency
names, a lockfile, and page files in the exact layout the framework requires,
including the cases that are easy to get wrong: route groups, catch-alls,
dynamic segments, and the non-page files (`layout`, `_app`, `+page.server.ts`)
that must **not** become routes.

They are walked and indexed through the real indexer in
`test/integration/fixtures.test.ts`, so a change to the walker, the ignore
rules or the detection strategies is checked against all five at once.

Adding a framework means adding a directory here and a strategy in
`src/detect.ts`. A framework with no fixture is not supported, whatever the code
says — the Done-when for BRAIN-2 requires the pair.

## Why they are excluded from typecheck and lint

These are miniature versions of *other people's* repositories, indexed as data.
Holding them to this project's compiler and lint settings would defeat their
purpose: a fixture only tests the indexer if it is shaped like a repository we
do not control, and some of these deliberately are — the Next.js API-route
handler has untyped parameters exactly as a real one often does.

So `tsconfig.json` excludes `test/fixtures/**` and `eslint.config.js` ignores
it. Nothing here is compiled or run; it is read.
