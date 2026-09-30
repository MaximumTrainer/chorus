# Deploying Chorus to Fly.io

This is the reference deployment (`deploy/docker-compose.yml`) placed on Fly.io. It uses the same image, the same three processes and the same Postgres and Redis images and settings. `test/nfr/bootstrap/fly.test.ts` holds each Fly command and image equal to its compose counterpart, so the two cannot drift apart. Fly is the first target in #144; the others (AWS, GCP, Azure) follow the same shape.

| Fly app | Config | What runs | Reached at |
|---|---|---|---|
| `chorus` | `deploy/fly/chorus.fly.toml` | `api`, `worker` and `collab` as process groups of one image; migrations as the release command | `https://chorus.fly.dev`, `wss://chorus.fly.dev:1234` |
| `chorus-postgres` | `deploy/fly/postgres.fly.toml` | `pgvector/pgvector:pg16` with a volume | `chorus-postgres.internal:5432` (private) |
| `chorus-redis` | `deploy/fly/redis.fly.toml` | `redis:7.4-alpine`, append-only, with a volume | `chorus-redis.internal:6379` (private) |

Postgres is a Fly app we run ourselves rather than Fly's managed Postgres. The migrator creates the application role it later connects as, which needs `CREATEROLE`. Retrieval also depends on `random_page_cost` (architecture.md §23.5), a setting this file controls and a managed service may not let us change. Redis is private for a similar reason: the queue client speaks plain TCP with a password, not TLS.

The region is `lhr` in all three files. To change it, change it in all three.

## One-time setup

Everything below costs money on your Fly account, so it is done by a person, once. The pipeline only deploys to apps that already exist.

Generate a strong value for each placeholder and keep them in a password manager. `openssl rand -base64 32` gives a suitable one.

```bash
# 1. Postgres, with its volume.
fly apps create chorus-postgres
fly volumes create chorus_postgres_data --app chorus-postgres --region lhr --size 10
fly secrets set --app chorus-postgres POSTGRES_PASSWORD=<db-owner-password>
fly deploy --config deploy/fly/postgres.fly.toml

# 2. Redis, with its volume.
fly apps create chorus-redis
fly volumes create chorus_redis_data --app chorus-redis --region lhr --size 1
fly secrets set --app chorus-redis REDIS_PASSWORD=<redis-password>
fly deploy --config deploy/fly/redis.fly.toml

# 3. The application. Its secrets must match the two above.
fly apps create chorus
fly secrets set --app chorus \
  CHORUS_DB_PASSWORD=<db-owner-password> \
  CHORUS_DB_APP_PASSWORD=<db-app-password> \
  CHORUS_REDIS_PASSWORD=<redis-password> \
  CHORUS_AUTH_SECRET=<auth-secret> \
  CHORUS_MASTER_KEY_ID=prod-1 \
  CHORUS_MASTER_KEY=<32-bytes-base64> \
  CHORUS_MODEL_BASE_URL=<your model endpoint> \
  CHORUS_MODEL_API_KEY=<its key> \
  CHORUS_MODEL_TIERS='<see deploy/model-tiers.example.json>'
fly deploy --config deploy/fly/chorus.fly.toml
```

`CHORUS_MASTER_KEY` encrypts integration credentials at rest (INT-1). Losing it makes stored credentials unrecoverable, and rotating it uses `CHORUS_MASTER_KEY_PREVIOUS` / `CHORUS_MASTER_KEY_PREVIOUS_ID`.

## The pipeline

`.github/workflows/deploy-fly.yml` deploys `chorus` after every green CI run on `main`, and can also be started by hand. It has three gates:

1. **CI is green on the exact commit.** The workflow starts only from a successful CI run on `main`, and deploys that run's head SHA rather than whatever `main` has become since.
2. **A person approves.** The job runs in the `production` environment. Add required reviewers under *Settings → Environments → production* and each deploy waits for an approval that is recorded on the run.
3. **The release proves itself.** Migrations run as Fly's release command, and a failure aborts the release while the previous version keeps serving. After the rolling update, `https://chorus.fly.dev/readyz` must answer before the run turns green.

To turn it on, create a deploy token and store it as an environment secret:

```bash
fly tokens create deploy --app chorus
```

Save the output as `FLY_API_TOKEN` under *Settings → Environments → production → Environment secrets*. Until that secret exists, the workflow skips with a notice rather than failing.

`chorus-postgres` and `chorus-redis` are not redeployed by the pipeline. Their images are pinned, and a database restart should be a decision someone makes, not a side effect of merging a pull request.

## Not covered yet

- **Object storage.** Nothing reads or writes the bucket yet. When something does, Fly's Tigris (`fly storage create`) is S3-compatible and sets the credentials as secrets on the app.
- **Worker health.** Fly has no check for a process without a port, so a worker whose consumers have died is not restarted automatically. Compose covers this with a heartbeat-file check; Fly has no equivalent.
- **Backups.** Fly takes daily snapshots of volumes, which you can restore with `fly volumes snapshots`. A logical `pg_dump` schedule is still worth adding before this holds data anyone depends on.
