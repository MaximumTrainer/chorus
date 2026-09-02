-- 0010 — webhook deliveries (INT-1 AC3).
--
-- Every delivery is stored, verified or not, for three reasons:
--
--   * deduplication needs a durable record of what has already been seen;
--   * replay is the only practical way to debug a connector against a source
--     you cannot reproduce on demand — yesterday's payload, today's code;
--   * a run of forged deliveries is worth being able to see.
--
-- Storing unverified deliveries is a deliberate trade. It admits writes driven
-- by an unauthenticated caller who knows an integration id, which is bounded by
-- the edge rate limiting NFR-3 requires rather than by this table. The
-- alternative — discarding forgeries silently — makes an attack invisible,
-- which is worse than making it noisy.
--
-- `signature_ok` is the gate on replay: an unverified payload must never become
-- executable later by whoever can reach the debugging endpoint.

CREATE TABLE webhook_deliveries (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  -- The source's own delivery identifier. Deduplication turns on this, so a
  -- delivery that carries none is refused rather than stored.
  delivery_id    text NOT NULL,
  signature_ok   boolean NOT NULL,
  -- Headers and the *raw* body. Re-serialising a parsed body changes its HMAC,
  -- which is the classic way a receiver rejects genuine deliveries in
  -- production and nowhere else — so a replay must verify what actually
  -- arrived, byte for byte.
  headers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload        text NOT NULL,
  -- Set only when the connector handled it without raising. A failed delivery
  -- stays unprocessed so a retry attempts it again rather than treating a
  -- failure as a completed delivery.
  processed_at   timestamptz,
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now()
);

-- Deduplication, enforced by the database rather than a read-then-write, which
-- is a race the moment a source retries in parallel with its first attempt.
CREATE UNIQUE INDEX webhook_deliveries_dedup
  ON webhook_deliveries (integration_id, delivery_id);
CREATE INDEX webhook_deliveries_recent
  ON webhook_deliveries (workspace_id, received_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_tenant ON webhook_deliveries
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
