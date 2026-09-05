-- 0026 — sessions, messages and quick actions (CHAT-1, architecture.md §8.2).
--
-- > The blank page is where most product tools lose their user.
--
-- The entry point is recorded rather than inferred, because it is the hint the
-- workflow router keys off (AGENT-2) and because "how did this session start"
-- is the first question anybody reading a transcript later actually has.
--
-- **Named `chat_sessions`, not `sessions`.** architecture.md §8.2 calls this
-- table `sessions`, and it cannot be: the authentication library is configured
-- with `modelName: 'sessions'` and creates that table itself at runtime, so a
-- migration claiming the name fails on a database that has ever been started.
-- The domain word stays "session" everywhere a person sees it; only the table
-- carries the qualifier.

CREATE TABLE chat_sessions (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id             text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title               text NOT NULL DEFAULT 'Untitled',
  -- Which of the three doors, or a quick action. Recorded, not derived from
  -- whether a seed happens to be present: `nothing` and an idea somebody left
  -- blank are different situations and must not collapse into one.
  entry_point         text NOT NULL
                        CHECK (entry_point IN ('idea', 'document', 'nothing', 'quick_action')),
  -- What the router should prefer, when the door implies one. `nothing`
  -- deliberately carries none.
  routing_hint        text,
  surface             text NOT NULL DEFAULT 'web',
  -- Where this conversation lives when it started somewhere else (Slack,
  -- Teams). Null for a session started in the product.
  external_thread_ref text,
  created_by          text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX chat_sessions_recent ON chat_sessions (workspace_id, team_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id     text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- Ordered explicitly rather than by timestamp: two messages written in the
  -- same millisecond would otherwise render in an arbitrary order, and a
  -- transcript that reorders itself is one nobody can quote from.
  seq            integer NOT NULL,
  role           text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  author_user_id text REFERENCES users(id) ON DELETE SET NULL,
  -- The run that produced an assistant message, so a turn links to its trace.
  run_id         text REFERENCES runs(id) ON DELETE SET NULL,
  content        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The context bundle this turn was grounded in (CHAT-3). Recorded per
  -- message so the "Context used" panel is exact rather than reconstructed.
  context_used   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX messages_ordered ON messages (session_id, seq);

-- Quick actions, per team (AC4).
--
-- A row per team rather than a column of JSON on `teams`: they are edited as a
-- set, read on every home page, and belong to whoever configured them.
CREATE TABLE quick_actions (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  prompt       text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  -- The workflow the action suggests. Advisory: the router still decides.
  hint         text,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX quick_actions_key ON quick_actions (workspace_id, team_id, key);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_sessions', 'messages', 'quick_actions'] LOOP
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
