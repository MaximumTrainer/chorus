-- 0035 — cached input tokens, counted apart (NFR-8, architecture.md §9.3).
--
-- §9.3 says prompt-prefix caching "is used where the provider supports it".
-- Once it is, a call's input divides into two kinds that cost roughly an order
-- of magnitude apart: tokens the provider read from its cache, and tokens it
-- processed fresh.
--
-- Folded into `tokens_in`, a cached run is billed at up to ten times what it
-- cost. That is worse than a visibly wrong number, because the row stays
-- internally consistent: `cost_cents` reconciles against `tokens_in` perfectly,
-- the per-run display reconciles against the ledger perfectly, and every check
-- anybody thinks to run agrees. Nothing downstream can recover the split once
-- the two have been added together, so the column has to exist before the
-- caching does.
--
-- Defaulted to zero, so every row written before caching existed keeps meaning
-- exactly what it meant: all of its input was fresh.

ALTER TABLE spend_ledger
  ADD COLUMN tokens_cached_in integer NOT NULL DEFAULT 0
    CHECK (tokens_cached_in >= 0);

COMMENT ON COLUMN spend_ledger.tokens_cached_in IS
  'Input tokens served from the provider prompt cache, billed at the cached rate. Separate from tokens_in because the two prices differ by roughly 10x and the split cannot be recovered once summed.';
