-- 0052 — an artefact link has a state, so a reference can outlive its target
-- (BRAIN-11 AC8).
--
-- When the owning source tombstones an external-authority entity, the entity
-- and its edges go, but a task or document that linked to it must not lose its
-- pointer silently: the link is marked `dangling` and kept. A dedicated column
-- rather than a flag inside `detail` so a reader — a view, a cleanup job — can
-- ask for dangling links directly rather than parsing JSON every row.
ALTER TABLE artefact_links
  ADD COLUMN state text NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'dangling'));
