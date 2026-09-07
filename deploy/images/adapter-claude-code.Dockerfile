# The `claude-code` adapter's sandbox image (CODE-3, CODE-4).
#
# This is where the Claude Code CLI lives, and it is the whole reason the
# adapter is not a boundary violation. `@anthropic-ai/*` may only be imported
# by `packages/llm` (ADR-0005, ADR-0018), and the boundary suite enforces it —
# but nothing in `apps/` or `packages/` imports this. It is installed into a
# container image and invoked as an entrypoint, so the dependency lives here,
# in `deploy/`, where an ops change can move it without a release.
#
# Pinned exactly. A sandbox image that floats is a job whose behaviour changed
# because somebody else published, and a coding job is the last place to
# discover that.

FROM node:22-bookworm-slim

# git, because the job clones and commits; ca-certificates, because everything
# it is permitted to reach is TLS. Nothing else: every tool present in this
# image is a tool a compromised agent can run.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global @anthropic-ai/claude-code@2.1.263

# Unprivileged, and it owns nothing outside its own workspace. Rootless Podman
# (ADR-0014) already means an escape lands as an unprivileged host user; this is
# the second layer, and it costs nothing.
RUN useradd --create-home --shell /bin/bash agent
USER agent
WORKDIR /workspace

# No ENTRYPOINT. The adapter supplies the command (`prepare` returns it), so
# what runs is visible in the job record rather than baked into a layer nobody
# reads. An image with a default entrypoint is an image that can run without the
# adapter having said what it should do.
