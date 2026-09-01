-- 0001 — identity and tenancy foundation (WS-1, WS-2, WS-3, NFR-3).
--
-- Every tenant table carries workspace_id and is covered by a row-level
-- security policy bound to the `app.workspace_id` session variable that
-- withTenant sets. The application role has no BYPASSRLS, so a query issued
-- outside a tenant context reads nothing rather than everything.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- Non-tenant tables: users exist above the workspace boundary, because one
-- person may belong to several workspaces (WS-2).
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id              text PRIMARY KEY,
  email           text NOT NULL,
  email_verified_at timestamptz,
  name            text,
  password_hash   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- Case-insensitive uniqueness: "Ada@example.com" and "ada@example.com" are one
-- person, and treating them as two makes account linking (WS-1 AC4) unsound.
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE UNIQUE INDEX workspaces_slug_key ON workspaces (lower(slug)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tenant tables. Each carries workspace_id and gets an RLS policy below.
-- ---------------------------------------------------------------------------

CREATE TABLE workspace_members (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('member', 'senior_member', 'admin', 'owner')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX workspace_members_unique ON workspace_members (workspace_id, user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX workspace_members_recent ON workspace_members (workspace_id, created_at DESC);

CREATE TABLE teams (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          text NOT NULL,
  -- The charter is injected into every agent prompt (WS-3 AC2), so it is
  -- bounded: an unbounded field becomes a cost and quality problem.
  charter       text NOT NULL DEFAULT '' CHECK (length(charter) <= 8000),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX teams_slug_key ON teams (workspace_id, lower(slug)) WHERE deleted_at IS NULL;
CREATE INDEX teams_recent ON teams (workspace_id, created_at DESC);

CREATE TABLE team_members (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id       text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_override text CHECK (role_override IN ('member', 'senior_member', 'admin', 'owner')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX team_members_unique ON team_members (team_id, user_id) WHERE deleted_at IS NULL;

CREATE TABLE invitations (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         text,
  -- Only a hash is stored: an invitation token is a credential (WS-2 AC2).
  token_hash    text NOT NULL,
  role          text NOT NULL CHECK (role IN ('member', 'senior_member', 'admin', 'owner')),
  allowed_domain text,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  accepted_by   text REFERENCES users(id),
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX invitations_token_key ON invitations (token_hash);
CREATE INDEX invitations_recent ON invitations (workspace_id, created_at DESC);

CREATE TABLE api_tokens (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- Hash only, with a display prefix, so a leaked database yields no usable
  -- token (WS-5 AC1).
  token_hash    text NOT NULL,
  token_prefix  text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX api_tokens_hash_key ON api_tokens (token_hash);
CREATE INDEX api_tokens_recent ON api_tokens (workspace_id, created_at DESC);

CREATE TABLE audit_events (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'run', 'integration', 'system')),
  actor_id      text,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text,
  before        jsonb,
  after         jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);

-- High-volume: the two access patterns are "recent in this workspace" and
-- "recent by this actor" (WS-6 AC3).
CREATE INDEX audit_events_recent ON audit_events (workspace_id, at DESC);
CREATE INDEX audit_events_by_actor ON audit_events (workspace_id, actor_id, at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- USING governs which rows are visible to read, update and delete;
-- WITH CHECK governs which rows may be written. Both are required: USING alone
-- would let a caller insert a row into another workspace.
--
-- current_setting(..., true) returns NULL when unset, and `= NULL` is never
-- true, so a query with no tenant context matches nothing — failing closed.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_members', 'teams', 'team_members', 'invitations', 'api_tokens', 'audit_events'
  ] LOOP
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
