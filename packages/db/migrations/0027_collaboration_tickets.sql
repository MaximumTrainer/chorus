-- DOC-2 AC5 — authorisation of the realtime channel.
--
-- The collaboration server is a second process with its own port, and a
-- WebSocket cannot carry the session cookie the browser holds. So the browser
-- asks the API — which already knows every rule about who may read what — for a
-- ticket, and presents that on the socket.
--
-- Issuing the ticket in the API rather than teaching the collaboration server
-- to answer "may this person read this document" is the whole design: two
-- implementations of one permission question drift, and the one that drifts is
-- the one nobody is looking at.
--
-- Deliberately narrow. A ticket names exactly one document, expires in
-- seconds rather than hours, and is consumed on first use — because a ticket
-- travels in a URL, and a URL ends up in a proxy log, a browser history and a
-- crash report.
CREATE TABLE collaboration_tickets (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash. The table is somewhere to check a ticket against, not
  -- somewhere to look one up, so the plaintext would add risk and no capability.
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  -- Set when the socket opens. A second connection with the same ticket is
  -- refused rather than joined.
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Expiry is swept, not merely checked: a table of dead tickets is a growing
-- record of who opened which document and when, kept for no reason.
CREATE INDEX collaboration_tickets_expiry ON collaboration_tickets (expires_at);

ALTER TABLE collaboration_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY collaboration_tickets_tenant ON collaboration_tickets
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
