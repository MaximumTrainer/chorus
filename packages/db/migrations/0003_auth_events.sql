-- 0003 — authentication audit trail (WS-1 definition of done, NFR-5).
--
-- Deliberately NOT a tenant table. Authentication happens before a workspace
-- exists: a person registers, verifies, and only then creates or joins one.
-- Putting these rows in `audit_events`, whose RLS policy requires a tenant,
-- would mean either inventing a workspace id for them or relaxing the policy --
-- and relaxing it would put a hole in the boundary that NFR-3 rests on.
--
-- The subject is an email address rather than a user id, because the most
-- valuable rows are the ones where no user exists: failed attempts against
-- addresses that were never registered are the reconnaissance phase of
-- credential stuffing, and they are invisible if keyed on a user.

CREATE TABLE auth_events (
  id        text PRIMARY KEY,
  kind      text NOT NULL CHECK (kind IN (
              'registration',
              'email_verified',
              'sign_in',
              'sign_in_failed',
              'sign_out',
              'password_reset_requested',
              'password_reset',
              'account_linked',
              'rate_limited'
            )),
  -- The email address the attempt concerned. Never a credential.
  subject     text NOT NULL,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  ip_address  text,
  user_agent  text,
  -- Structured context. Must never contain a password, token or hash.
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

-- The two questions asked of this table: "what happened to this address?" and
-- "what happened recently?"
CREATE INDEX auth_events_by_subject ON auth_events (lower(subject), at DESC);
CREATE INDEX auth_events_recent ON auth_events (at DESC);
