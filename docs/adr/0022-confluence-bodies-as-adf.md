# ADR-0022: Confluence page bodies are read and written as ADF, not storage-format XHTML

- **Status:** Accepted
- **Date:** 2026-11-10
- **Requirement:** INT-9 (#121)

## Context

INT-9 needs a converter between Confluence page bodies and Markdown, with the
macro handling AC3 names (expand, table-of-contents, tracker-issue, and unknown
macros preserved as a labelled placeholder). The requirement text permits either
representation — "Storage-format XHTML **or ADF** converts to Markdown" — while
AC2's round-trip is phrased in terms of storage format.

Confluence has two body representations:

- **Storage format** — XHTML with `<ac:structured-macro>` elements. Parsing it
  correctly needs a real XML parser (nested tags, attributes, CDATA inside
  macros). The repository has no XML/HTML parser, and adding one is itself an
  ADR-worthy dependency decision (CLAUDE.md §7).
- **ADF** — the same Atlassian Document Format Jira uses, served by the
  Confluence Cloud v2 API (`body-format=atlas_doc_format`). Chorus already has a
  tested ADF ↔ Markdown converter (`adf.ts`, INT-8 AC3), and macros appear as
  `extension` / `bodiedExtension` / `inlineExtension` nodes.

## Decision

**Confluence page bodies are read and written as ADF, reusing the shared ADF
converter.** The Confluence-specific work is macro resolution: before rendering,
the connector rewrites macro extension nodes into standard ADF — an expand keeps
its body, a tracker-issue macro becomes a Ticket link, a table-of-contents
macro becomes a labelled marker, and an unknown macro becomes a labelled
placeholder rather than being dropped. Everything else — headings, lists,
tables, code, links, images — round-trips through the existing converter, so
AC2's round-trip is read as ADF → Markdown → ADF.

## Consequences

- No new dependency, and no second rich-text converter to maintain; the macro
  logic is the only Confluence-specific content code.
- Honours AC3's "preserved as a labelled placeholder" for unknown macros, which
  the implementation note calls out as the most common failure of this kind of
  integration.
- **Data Center**, which serves storage-format XHTML and not ADF, is not covered
  by this converter. When Data Center support is scheduled, a storage-format
  converter is added behind the same interface; the ADF path and its tests are
  unaffected. This is the same shape as the Jira connector's Cloud-first stance.
