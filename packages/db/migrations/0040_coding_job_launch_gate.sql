-- 0040 — a coding job held at its before_coding_job checkpoint (CODE-1 AC4, MCP-3 AC6).
--
-- A launch nobody clicked (an agent's start_coding_job, a script's token) is
-- held under an `ask` policy: the job exists so the person deciding can see
-- exactly what would run, but nothing may provision it until they approve.
-- That is a state of its own rather than `queued` with a flag, because every
-- consumer that picks up `queued` work would otherwise have to remember to
-- check the flag, and the one that forgets runs an unapproved job.

ALTER TABLE coding_jobs DROP CONSTRAINT coding_jobs_status_check;
ALTER TABLE coding_jobs ADD CONSTRAINT coding_jobs_status_check
  CHECK (status IN ('awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled'));

-- A held job is the task's active job. Asking again while it waits returns it,
-- and a person's click does not start a second agent beside it (CODE-1 AC3).
DROP INDEX coding_jobs_one_active;
CREATE UNIQUE INDEX coding_jobs_one_active
  ON coding_jobs (task_id)
  WHERE status IN ('awaiting_approval', 'queued', 'running');
