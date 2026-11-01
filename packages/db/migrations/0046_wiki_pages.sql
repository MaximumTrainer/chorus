-- 0046 — compiled wiki pages (BRAIN-5).
--
-- Principle 2: context is compiled, not curated. For each salient entity the
-- compiler renders a Markdown page and lands it here; a later slice commits
-- these to git under a bot identity. The page is stored as well as pushed so
-- the compiler can tell what changed since last time (incremental, AC3) and so
-- the inbox can find pages that have gone stale without a working tree.
--
-- `human_edited_at` is the guard: a page a person edited in git is never
-- silently overwritten (AC4). `content_hash` is how an unchanged entity is
-- skipped rather than rewritten.

CREATE TABLE wiki_pages (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id      text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  kind           text NOT NULL,
  markdown       text NOT NULL,
  content_hash   text NOT NULL,
  -- Set when a human edited the page in git; the compiler refuses to overwrite
  -- a hand-edited page and raises a review item instead (AC4).
  human_edited_at timestamptz,
  compiled_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One page per entity, and one page per slug within a kind — the path
-- wiki/<kind>/<slug>.md must be unique.
CREATE UNIQUE INDEX wiki_pages_entity ON wiki_pages (workspace_id, entity_id);
CREATE UNIQUE INDEX wiki_pages_slug ON wiki_pages (workspace_id, kind, slug);

ALTER TABLE wiki_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY wiki_pages_tenant ON wiki_pages
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
