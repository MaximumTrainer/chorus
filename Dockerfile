# One image, two entrypoints (architecture.md §6, NFR-1).
#
# `api` and `worker` are separate *processes* that scale independently, but they
# share a dependency tree and a build. Two Dockerfiles would mean two builds of
# the same monorepo and two chances for them to drift onto different commits —
# and a worker running different code from the API that enqueued to it is a
# class of bug that is very hard to see.
#
# The command decides which process runs, so a deployment scales them separately
# while `docker compose up` stays one build.

FROM node:22.11.0-alpine AS base
# git: the indexer checks out working copies (BRAIN-2).
RUN apk add --no-cache git tini
# pnpm is installed directly at a pinned version rather than through corepack.
# Corepack in this Node image ships a signing key that has since expired, so it
# refuses to fetch a package manager at all — and even working, it resolves a
# version at build time, which is one more thing that can change between two
# builds of the same commit.
RUN npm install --global pnpm@9.12.3

WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies, cached on the lockfile alone so a source change does not
# reinstall the world.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
COPY packages/queue/package.json packages/queue/
COPY packages/connectors/package.json packages/connectors/
COPY packages/indexer/package.json packages/indexer/
COPY packages/testing/package.json packages/testing/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --prod=false

# ---------------------------------------------------------------------------
# The application.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# Dependencies from the deps stage — resolved from the lockfile alone, so an
# image never ships whatever happened to be installed on the machine that built
# it. `.dockerignore` keeps the source copy below from overwriting them.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY . .

# Unprivileged: nothing here needs root, and a container that runs as root is
# one exploit away from being a host problem.
RUN addgroup -S chorus && adduser -S chorus -G chorus && chown -R chorus:chorus /app
USER chorus

# tini reaps the zombies a Node process spawning `git` would otherwise leave.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]
