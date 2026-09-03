# ADR-0014: Rootless Podman is the default sandbox runtime; gVisor is the hardened option; Kubernetes is not required

- **Status:** Accepted
- **Date:** 2026-09-03
- **Decision:** D-6, deadline end of Phase 0 (`plan.md` §7)
- **Requirement:** CODE-4, NFR-1, NFR-3
- **Supersedes:** nothing. Resolves open decision 6 in `architecture.md` §27.

## Context

`architecture.md` §12.3 lists the sandbox properties as non-negotiable and backed
by a dedicated security suite: a fresh container per job, only the target
repository, no platform or workspace credentials, an egress allow-list, and
enforced CPU, memory, disk and wall-clock limits.

What was left open is **what runs the container on a shared host**, and the
choice is load-bearing in two directions at once. It determines host preparation
and CI capability for Phase 2 — deciding late blocks that phase on
infrastructure — and it sits directly against NFR-1, whose first promise is that
`docker compose up` on a 4 vCPU / 8 GB host reaches a working system for a
ten-person team.

The candidates from §27 are rootless Docker, Podman, gVisor, or requiring
Kubernetes.

The threat model matters more than the feature comparison. The code inside a
sandbox is **written by a model, from a brief, on behalf of a user who asked for
it**. It is not hostile input in the way a public code-execution service faces;
it is untrusted in the way a dependency is untrusted — capable of doing
something damaging by accident or through a prompt-injected instruction, and not
expected to be actively hunting for a kernel exploit. What we must stop
reliably: reading another workspace's data, reaching the platform database,
exfiltrating credentials, and consuming the host. What we must stop *eventually*
and can pay more for: a determined container escape.

Two facts about the deployments settled it. Most self-hosters will run one host,
and a runtime that requires Kubernetes turns a `docker compose up` product into
a cluster product. And the multi-tenant hosted case — several workspaces' jobs
on shared hardware — has a materially stronger threat model than a single team
running its own jobs on its own box.

## Decision

**Three tiers, one contract.** The `Sandbox` interface (§12.3) is the only thing
the platform codes against; which runtime satisfies it is deployment
configuration, `CHORUS_SANDBOX_RUNTIME`.

1. **Rootless Podman — the default.** Daemonless and rootless by design, so a
   container escape lands as an unprivileged user rather than as root. It reads
   Compose files and runs unmodified OCI images, so it changes nothing about how
   the product is packaged. It needs no cluster and no kernel modules.
2. **gVisor (`runsc`) — the hardened option**, and **required for multi-tenant
   hosted deployments** where workspaces that do not trust each other share
   hardware. It intercepts syscalls in userspace, which is the meaningful
   defence against escape, and costs syscall-heavy performance — which a
   `git clone` plus a test run is, so the cost is real and worth measuring
   before it is assumed acceptable.
3. **Rootless Docker — supported, not recommended.** Many hosts already have it,
   and refusing it would cost adoption for no security gain over Podman. It is
   documented as equivalent-minus-daemonless.

**Kubernetes is explicitly not required.** It remains a supported target through
the Helm chart (NFR-1), and the sandbox runtime there is whatever the cluster
provides, but no Chorus feature may assume it.

The security suite (§12.3, `plan.md` §5) runs against **every** configured
runtime rather than the default alone. A guarantee that holds under Podman and
not under gVisor is not a guarantee — it is a property of one deployment, and
the one it fails on is the multi-tenant one.

## Consequences

**What this buys.** NFR-1's promise survives: a self-hoster installs one package
and gets a working sandbox. The hosted case gets a genuinely stronger boundary
without a second codebase, because the contract is the same. And the choice is
reversible per deployment rather than baked into the product.

**What it costs.** Two runtimes to test, and CI must exercise both — which means
CI hosts need gVisor available, and that is Phase 2 host preparation work that
now has a name. The gVisor performance penalty on syscall-heavy workloads is
unmeasured here and could turn out to make coding jobs unacceptably slow; if it
does, the answer is to keep gVisor for multi-tenant and accept a longer job
time, not to weaken the boundary.

**What it does not decide.** Egress enforcement mechanism (a network namespace
plus a filtering proxy is the likely answer, but that is CODE-4's design), image
provenance and signing, or the per-adapter base images. Those are CODE-3 and
CODE-4 work with their own criteria.

**The trigger to revisit.** Measured job wall-clock under gVisor exceeding the
NFR-7 budget for coding jobs, or a self-hoster population that turns out to be
predominantly Kubernetes-first. Either is a reason to reopen; neither is a
reason to require a cluster today.
