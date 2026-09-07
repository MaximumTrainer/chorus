# The reference adapter's sandbox image (CODE-3 AC2).
#
# Deliberately the smallest image here: the reference adapter's whole point is
# that a deployment needs no third-party coding CLI. It carries a Node runtime,
# git, and nothing else — if this image ever needs a vendor tool, the adapter
# has stopped being the fallback it exists to be.

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash agent
USER agent
WORKDIR /workspace
