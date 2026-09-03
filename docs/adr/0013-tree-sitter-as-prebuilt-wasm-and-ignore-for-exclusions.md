# ADR-0013: tree-sitter ships as prebuilt WASM, and `.gitignore` semantics are not hand-rolled

- **Status:** Accepted
- **Date:** 2026-09-03
- **Requirement:** BRAIN-2
- **Supersedes:** nothing. Implements the parsing decision already recorded in `architecture.md` §10.2.

## Context

`architecture.md` §10.2 already decided that repository indexing uses
**tree-sitter** for symbols and imports. This ADR is about *how* it arrives, and
about one adjacent dependency BRAIN-2 forces a decision on, because CLAUDE.md §7
makes any new dependency an ADR-level choice.

### tree-sitter

Two ways to get it:

1. **Native bindings** (`tree-sitter` plus a grammar package per language).
   Compiled through `node-gyp` at install time, so every deployment host needs a
   C toolchain and Python, and every grammar is a separate compile.
2. **WebAssembly** (`web-tree-sitter` plus `.wasm` grammar files). No compiler,
   no install-time build, identical bytes on every platform.

NFR-1's first promise is that `docker compose up` on a clean host reaches a
working system, and CI verifies exactly that on a clean runner. Native bindings
put a C toolchain between a self-hoster and their first successful boot, and
`node-gyp` failures are the least diagnosable class of install error there is.
That alone decides it.

The remaining question is where the `.wasm` grammars come from. Building them
per language means committing binaries we compiled, or a build step per grammar.
`@vscode/tree-sitter-wasm` publishes prebuilt, **version-matched** grammars for
bash, C#, C++, CSS, Go, INI, Java, JavaScript, PHP, PowerShell, Python, regex,
Ruby, Rust, TSX and TypeScript, alongside the runtime they were built against.
Matched matters: a grammar compiled for a different runtime ABI fails at load
with an error that reads like a corrupt file.

A timeboxed spike confirmed it parses TypeScript and returns symbol kinds with
line ranges, from Node, with no build step.

### `.gitignore` semantics

BRAIN-2 AC5 says paths excluded by `.gitignore` or `.chorusignore` must be
absent from the index **including from embeddings**, and asks for that to be
asserted for secrets-like paths specifically. That makes exclusion a security
property, not a tidiness one.

`.gitignore` matching is deceptively hard: negation with `!`, anchoring on a
leading or embedded `/`, `**` spanning directories, trailing-slash
directory-only rules, and precedence where a later rule overrides an earlier
one. A subset implementation does not fail loudly — it silently indexes a file
somebody believed was excluded, which is precisely the failure AC5 exists to
prevent.

## Decision

Take both, as dependencies of a new `packages/indexer`:

- **`@vscode/tree-sitter-wasm`** — the tree-sitter runtime and prebuilt,
  version-matched WASM grammars. No native compilation anywhere in the install.
- **`ignore`** — the reference implementation of `.gitignore` semantics used by
  ESLint and much of the ecosystem. Zero dependencies, small, and correct about
  the cases above.

Language support is whatever the grammar bundle provides, mapped by file
extension. A file in an unsupported language is still indexed as a file and
chunked by a fallback window; it simply yields no symbols. That is the honest
degradation: the file is retrievable, and its structure is not claimed.

## Consequences

**What this buys.** `pnpm install` needs no compiler on any platform, which
keeps NFR-1's promise intact. Adding a language is adding a row to an extension
map, not a build target. And the one rule set where being subtly wrong means
indexing a secret is handled by the implementation everyone else already relies
on.

**What it costs.** WASM parsing is slower than native — materially so on a large
repository, and BRAIN-2 AC6 has a throughput budget against a 500k-LOC
benchmark. That budget is not yet measured, so this decision is provisional
against it: if WASM cannot meet it, the options are parallelism across worker
processes first, and native bindings as an optional accelerator second, with
WASM staying the default so a clean host still boots. The benchmark is the thing
that decides, and it does not exist yet — noted here rather than assumed away.

We also take a version coupling: runtime and grammars must be upgraded together,
because they are matched. That is a feature of the bundle, not a cost of it, but
it does mean the grammars cannot be bumped independently to pick up a language
fix.

**What it does not decide.** Whether a language is *supported* — that is the
extension map, and adding one is not an ADR. Nor does it decide chunking, which
is where retrieval quality actually comes from.
