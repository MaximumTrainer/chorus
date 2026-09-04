-- 0025 — documents and their templates (DOC-1, architecture.md §8.2).
--
-- The template is where a team's standard for "good enough to build" lives, and
-- it is also the structure the agent fills. Two consequences shape this schema.
--
-- Templates are **versioned and immutable**: editing publishes a new version
-- rather than mutating the old one, so a document created last month still
-- renders as its author left it. Rewriting existing documents on a template
-- edit would silently discard whatever people had written into sections the new
-- template dropped.
--
-- A document stores its sections as `{ key, title, guidance, required, content }`.
-- Guidance travels with the section for display and is excluded from every
-- export: guidance that reaches an export reads as though the author wrote the
-- platform's questions into their own document, and an agent reading it back
-- treats it as content.

CREATE TABLE document_templates (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('prd', 'spec', 'strategy', 'freeform', 'gap_spec')),
  version      integer NOT NULL CHECK (version >= 1),
  -- Ordered sections. Position in the array is the order, because a separate
  -- ordering column on a nested structure is one that drifts from it.
  sections     jsonb NOT NULL,
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A version is immutable once published, so a document in flight keeps
-- rendering against the one it was created with.
CREATE UNIQUE INDEX document_templates_version
  ON document_templates (workspace_id, team_id, type, version);

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY document_templates_tenant ON document_templates
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE TABLE documents (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id          text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  type             text NOT NULL
                     CHECK (type IN ('prd', 'spec', 'strategy', 'freeform', 'gap_spec')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  -- Which template produced it, recorded so "why does this one look different"
  -- is answerable rather than a mystery (AC2).
  template_id      text REFERENCES document_templates(id) ON DELETE SET NULL,
  template_version integer NOT NULL DEFAULT 1,
  sections         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The collaborative document state arrives with DOC-2. Nullable until then,
  -- rather than a second schema later.
  ydoc             bytea,
  -- Rendered markdown, kept for search and export. A cache: `sections` is the
  -- record, and anything that disagrees with them is stale rather than right.
  body_md_cache    text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
  approved_by      text REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  created_by       text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,

  -- An approved document names who approved it and when. A row claiming
  -- approval by nobody is exactly the state an accountability record must not
  -- be able to reach.
  CONSTRAINT documents_approval_is_attributed CHECK (
    status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX documents_by_team ON documents (workspace_id, team_id, type)
  WHERE deleted_at IS NULL;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant ON documents
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
