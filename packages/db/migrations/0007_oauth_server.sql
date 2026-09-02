-- 0007 — the platform OAuth 2.1 authorization server (WS-5 AC3, AC4, AC5).
--
-- MCP's authorization specification requires dynamic client registration and
-- PKCE, so Chorus must *be* an authorization server rather than merely consume
-- one. Four tables, split by what each one knows about tenancy:
--
--   oauth_clients                 no workspace: registration is anonymous and
--                                 happens before any user has consented.
--   oauth_authorization_requests  no workspace: choosing one *is* the consent
--                                 step, so a pending request cannot yet name it.
--   oauth_grants                  a workspace: the consent a person gave.
--   oauth_tokens                  a workspace, inherited from its grant.
--
-- The two non-tenant tables carry no workspace_id and therefore, correctly, no
-- RLS policy — the same reasoning as `users` and `auth_events`. Neither holds
-- workspace data: a client registration is public information by construction
-- (anyone may register), and an authorization request is bound to the user who
-- created it, which is what makes it safe without a tenant boundary.

-- ---------------------------------------------------------------------------
-- Clients. Registered dynamically, by anyone, per RFC 7591.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_clients (
  id                text PRIMARY KEY,
  client_name       text NOT NULL CHECK (length(client_name) <= 200),
  -- Public clients (native apps, the extension) authenticate with PKCE alone
  -- and have no secret to store. Confidential clients store only a hash, for
  -- the same reason an API token does.
  client_secret_hash text,
  redirect_uris     text[] NOT NULL CHECK (cardinality(redirect_uris) > 0),
  grant_types       text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
  response_types    text[] NOT NULL DEFAULT '{code}',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  scope             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- Pending authorization requests.
--
-- Created when the user is shown the consent screen and consumed when they
-- answer. Bound to `user_id` at creation, which is what prevents a forged
-- consent: an attacker cannot create a request in the victim's name, so a
-- stolen request id is useless without the victim's own session.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_authorization_requests (
  id                 text PRIMARY KEY,
  client_id          text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri       text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{}',
  -- The client's commitment. The verifier that opens it never reaches us until
  -- the exchange, which is the whole of PKCE.
  code_challenge     text NOT NULL,
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  state              text,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_authorization_requests_expiry ON oauth_authorization_requests (expires_at);

-- ---------------------------------------------------------------------------
-- Grants: one consent, by one person, for one client, in one workspace.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_grants (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id     text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes        text[] NOT NULL DEFAULT '{}',
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX oauth_grants_by_user ON oauth_grants (workspace_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tokens: authorization codes, access tokens and refresh tokens.
--
-- One table, because all three are the same thing — a hashed secret, issued
-- against a grant, that expires and can be spent or revoked. Splitting them
-- would triple the number of places the liveness predicate is written, and
-- liveness is exactly what AC5 turns on.
--
-- `consumed_at` is what makes a code single-use and makes refresh rotation
-- detectable: a spent token is kept rather than deleted, because recognising
-- that a *dead* token was presented again is the whole of AC4.
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_tokens (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  grant_id      text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  token_hash    text NOT NULL,
  -- Only a code carries these; they are what the exchange is checked against.
  code_challenge text,
  redirect_uri  text,
  -- The token this one replaced, so a rotation chain is walkable when
  -- investigating a reuse incident.
  parent_id     text REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX oauth_tokens_hash_key ON oauth_tokens (token_hash);
CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (workspace_id, grant_id, kind);

-- ---------------------------------------------------------------------------
-- Row-level security, for the two tables that carry a workspace.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oauth_grants', 'oauth_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (workspace_id = current_setting('app.workspace_id', true))
        WITH CHECK (workspace_id = current_setting('app.workspace_id', true))
    $f$, t);
  END LOOP;
END
$$;
