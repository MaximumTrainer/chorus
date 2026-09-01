-- 0002 — reconcile identity storage with the auth library (WS-1, ADR-0011).
--
-- Forward-only. Migration 0001 is not edited even though nothing is deployed
-- and editing would be easier: the forward-only rule (architecture.md §8.4) is
-- worth more than the convenience, and this is the first chance to demonstrate
-- it rather than assert it.
--
-- These four tables are deliberately NOT tenant tables. A user exists above the
-- workspace boundary, because one person may belong to several workspaces
-- (WS-2). They carry no workspace_id, get no RLS policy, and are correctly
-- absent from TENANT_TABLES. Membership and role live in workspace_members,
-- which is tenant-scoped.

-- `users` already exists from 0001. Bring it to the shape the auth library
-- needs, keeping Chorus naming conventions (architecture.md §28): snake_case
-- columns, plural table names.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS image text;

-- 0001 modelled verification as a timestamp; the library models it as a
-- boolean. Carry across any existing state before the old column goes, so the
-- migration is correct even on a database that already has rows.
UPDATE users SET email_verified = true WHERE email_verified_at IS NOT NULL;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;

-- The password hash moves to `accounts`, which also holds linked OIDC
-- providers. One place for "how this person proves who they are".
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;

CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_key ON sessions (token);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS accounts (
  id                        text PRIMARY KEY,
  user_id                   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'credential' for a password, otherwise the OIDC provider id.
  provider_id               text NOT NULL,
  -- The subject at that provider, or the user id for a password credential.
  account_id                text NOT NULL,
  issuer                    text,
  -- Hash only. Never a readable password (WS-1).
  password                  text,
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- One credential per provider per subject: the constraint that makes account
-- linking (WS-1 AC4) deterministic rather than a race.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_subject_key
  ON accounts (provider_id, account_id);
CREATE INDEX IF NOT EXISTS accounts_by_user ON accounts (user_id);

CREATE TABLE IF NOT EXISTS verifications (
  id          text PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verifications_by_identifier ON verifications (identifier);
-- Expiry is swept, so the index earns its place.
CREATE INDEX IF NOT EXISTS verifications_expiry ON verifications (expires_at);

-- The auth library issues *stateless* signed verification tokens: nothing is
-- written to `verifications`, so a link stays replayable until it expires.
-- WS-1 AC2 requires single use, so consumption is recorded here and replays are
-- refused. The harm from a replay is modest -- verification is idempotent and
-- issues no session -- but a link leaked through browser history, a proxy log
-- or a forwarded email should not remain usable for its whole lifetime.
CREATE TABLE IF NOT EXISTS consumed_tokens (
  token_hash  text PRIMARY KEY,
  purpose     text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

-- Swept once the underlying token could no longer be valid anyway.
CREATE INDEX IF NOT EXISTS consumed_tokens_age ON consumed_tokens (consumed_at);
