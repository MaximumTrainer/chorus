-- 0051 — operational edge kinds (BRAIN-11 AC4).
--
-- An external graph supplies `deployed_to` and `runs_on` between its entities —
-- a deployment to an environment, a service on a resource. Their provenance is
-- the source event's and their confidence is 1.0; the extractor stores them as
-- given and never re-scores them.
ALTER TABLE entity_edges DROP CONSTRAINT entity_edges_kind_check;
ALTER TABLE entity_edges ADD CONSTRAINT entity_edges_kind_check CHECK (kind IN (
  'implements', 'mentions', 'depends_on', 'owned_by', 'measured_by',
  'decided_in', 'duplicates', 'blocks', 'relates_to',
  'deployed_to', 'runs_on'
));
