-- 0056 — a changed source item is a new signal, superseding the last (BRAIN-1 AC3).
--
-- 0009 made signals unique on (integration_id, external_id, kind), so when a
-- source item's content changed, the new content hit the index and was refused:
-- the change was lost. Signals are immutable — never updated — so a change is a
-- new row that names the one it supersedes. "Supersession is a relationship,
-- never an update": the superseded row is not touched, and the link lives on the
-- newer row.
--
-- The current version of an item is the one nothing supersedes. Every reader
-- that decides what someone may see reads current versions only: a page that
-- was public and is now restricted must not stay visible through its old row.
ALTER TABLE signals ADD COLUMN supersedes_id text REFERENCES signals(id) ON DELETE CASCADE;

DROP INDEX signals_dedup;

-- Still one *first* version per item, so two writers racing to ingest a new
-- item cannot both succeed (the second is the duplicate it always was).
CREATE UNIQUE INDEX signals_first_version
  ON signals (integration_id, external_id, kind) WHERE supersedes_id IS NULL;
-- And each version is superseded at most once, so an item's history is a single
-- chain: two writers racing to record the same edit cannot fork it.
CREATE UNIQUE INDEX signals_one_successor
  ON signals (supersedes_id) WHERE supersedes_id IS NOT NULL;
-- Finding an item's versions to compare against.
CREATE INDEX signals_by_item ON signals (integration_id, external_id, kind);
