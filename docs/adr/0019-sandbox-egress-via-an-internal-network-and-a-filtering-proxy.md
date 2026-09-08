# ADR-0019: Sandbox egress is denied by topology and allowed by a filtering proxy

- **Status:** Accepted
- **Date:** 2026-09-08
- **Requirement:** CODE-4 AC2, NFR-3
- **Issue:** #169
- **Follows:** [ADR-0014](0014-sandbox-runtime-on-shared-hosts.md), which chose the runtimes and said explicitly that the egress mechanism was "CODE-4's design".

## Context

`architecture.md` §12.3 requires that a sandbox's egress be "restricted to an
allow-list: git host, model endpoint, package registries; everything else
refused at the network layer", and CODE-4 AC2 requires that refusal to be
demonstrated "with a real connection attempt, not by inspecting configuration".

The threat model from ADR-0014 is the one that matters here. The code inside a
sandbox is written by a model, from a brief, on behalf of a user who asked for
it. It is untrusted the way a dependency is untrusted: capable of doing
something damaging by accident or through a prompt-injected instruction. What
must be stopped reliably is exfiltration — a model that has been told, by
content it retrieved, to post the repository somewhere.

`plan.md` §8 attached spike S-1 to this question: *"Can egress be blocked at the
network layer on the chosen runtime, rootless?"*, with a working denial by real
connection attempt as its exit condition.

## Decision

**Egress is denied by topology, and allowed by a proxy. In that order.**

Each job gets two networks and two containers:

- an **internal** network (`--internal`), which has no route off the host;
- an ordinary network, which does;
- the **sandbox**, attached only to the internal network;
- a **proxy**, attached to both, holding the only path out.

The sandbox is given `HTTP_PROXY`/`HTTPS_PROXY` pointing at that proxy, and the
proxy answers `CONNECT` only for hosts on the job's allow-list, matching a bare
host or a subdomain of one. Everything else gets 403. Plaintext HTTP through the
proxy is refused outright: a coding job reaches git hosts and package registries
over TLS, and a proxy that also forwarded plaintext would be a second, quieter
way out.

**The internal network is the control; the proxy is the convenience.** This is
the whole of the decision. A proxy on its own would be enforcement by the
adapter's cooperation — it works exactly as long as the job honours the
environment variables it was given — and an adapter is precisely the thing that
might be compromised. The internal network means a job that ignores those
variables, or sets its own, or opens a raw socket, reaches nothing at all.

That distinction is asserted rather than asserted-about. `test/nfr/sandbox-runtime.test.ts`
makes a **direct** connection from inside a real container, bypassing the proxy,
and requires it to fail — including to an allow-listed host, because reaching
`example.com` without going through the proxy would mean the topology had a hole
in it whether or not the allow-list happened to permit that name.

**Every check carries a positive control.** "The sandbox could not reach the
internet" is worth nothing on its own: it passes when the image has no network
tooling, when the host is offline, and when the container failed to start. So
the allow-listed host must succeed in the same test in which the blocked one
fails.

## Consequences

**What this buys.** The guarantee survives a compromised adapter, which is the
only threat model worth designing for here. It needs no `NET_ADMIN`, no iptables
inside the container and no privileged flag — all of which would have traded a
network boundary for a larger kernel attack surface. And it is per-job: two jobs
cannot see each other, because neither network is shared.

**What it costs.** Two networks and one extra container per job. The proxy is a
component we own and must keep small enough to read; it is inline in the runner
for that reason, rather than an image with its own build and registry entry. DNS
resolution happens inside the proxy rather than the sandbox, which is a
behaviour difference a job could in principle notice.

**What it does not decide.** Per-adapter base images, image provenance and
signing, and the disk quota — `--storage-opt size=` needs a storage driver with
project quotas (`overlay2` with `pquota`, or `xfs`), which is a host-preparation
matter rather than a design one.

## What is deliberately not decided

**Whether the same topology holds under gVisor and rootless Podman.** ADR-0014
is explicit that the security suite must run against every configured runtime,
because *"a guarantee that holds under Podman and not under gVisor is not a
guarantee — it is a property of one deployment, and the one it fails on is the
multi-tenant one."* The design is runtime-agnostic on paper: `--internal`
networks and CONNECT proxying are not Docker features. It has been demonstrated
under Docker with `runc` and nowhere else, and it stays unproven under the other
two until a host with them exists. #169 carries that remainder.
