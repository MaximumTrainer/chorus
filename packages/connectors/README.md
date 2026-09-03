# `@chorus/connectors` — the connector framework

Every connector inherits its correctness from this package. Credential
encryption, cursor durability, webhook deduplication and rate-limit handling are
solved **once**, here, because the alternative is a dozen connectors each subtly
broken in its own way.

If you are adding a connector, you write four things — a kind, an auth spec, a
`pull` and/or a `handleWebhook`, and a `health` — and the framework does the
rest. You do not write persistence, and you cannot: a connector is handed its
decrypted credentials for the duration of one call and is given no way to reach
the database.

---

## The interface

```ts
interface Connector {
  kind: ConnectorKind          // must be in CONNECTOR_KINDS (packages/core)
  auth: AuthSpec               // 'oauth2' | 'token' | 'none'
  capabilities: Capabilities   // { source?, sink?, repos? }

  pull?(cursor: string | null, ctx: ConnectorContext): Promise<PullResult>

  webhooks?: WebhookSpec
  handleWebhook?(request: WebhookRequest, ctx: ConnectorContext): Promise<readonly Signal[]>

  health(ctx: ConnectorContext): Promise<HealthStatus>
}
```

The interface is deliberately small, and it grows only when a contract-kit
guarantee demands it. An optional member nothing enforces is a promise to you
that the framework does not keep.

### Rules that will bite you if you ignore them

**Your cursor must not be an offset.** Return an opaque string that identifies a
position — the id of the last item you served, the source's own page token, a
high-water timestamp. A source that inserts an item between pages shifts every
offset after it, so an offset cursor silently skips or repeats exactly when the
corpus is busiest.

**`nextCursor: null` means caught up**, not "start again". Returning the last
position instead makes every sync end with a wasted empty page.

**External ids must be stable across calls.** Deduplication is
`(integration_id, external_id, kind)`. If you mint a fresh id per call, replay
duplicates every effect it exists to make safe.

**`occurredAt` is when the thing happened at the source**, never when you
ingested it. A signal stamped with its ingest time is misfiled forever and
nothing downstream can tell.

**Capture permission scope at ingest.** A `restricted` signal must name at least
one scope id — the channel, the page restriction, the sensitivity label. The
envelope refuses to express a restricted signal with no scope, because the
retrieval predicate would then either match nothing or match everything, and
both readings are wrong.

**Raise `RateLimitedError` with a `retryAfterMs`** when the source asks you to
slow down. It is a distinct error from a generic failure because the two demand
opposite responses: the runner resumes after a rate limit and gives up after a
failure. Take the delay from the source's own headers where it offers them.

**`WebhookRequest.body` is the raw string.** Verify against it, never against a
re-serialised parse — key order and whitespace both change an HMAC, which is the
classic way a receiver rejects genuine deliveries in production and nowhere
else.

**Compare signatures in constant time.** `verify` is yours to implement, so this
is on you. Compare lengths first: `timingSafeEqual` throws on a mismatch, and a
presented signature's length is entirely the caller's choice.

---

## What the framework guarantees you

- **Credentials** are envelope-encrypted — a per-workspace data key, wrapped by a
  master key — and never reach you as ciphertext or leave you as plaintext. Error
  messages are redacted against your own credentials before they are stored,
  because a connector that interpolates its context into an error is how a
  credential reaches a page an admin can read.
- **Sync** commits each page and the cursor that follows it in one transaction,
  so a crash loses no work and repeats none.
- **Ingestion is idempotent** in the database, by unique index. Serving the same
  item twice is free.
- **Webhooks** are verified *before* they are deduplicated — the other order lets
  a forgery claim a delivery id and have the genuine delivery discarded later as
  a repeat — stored raw, and replayable.
- **Health** keeps the last success across a failure, so an admin can read
  "failing since 09:00, last worked at 08:55".

---

## The contract kit

Every connector must pass the same suite. That is the point: a guarantee that
holds for one connector and not another is not a guarantee. It runs against
recorded fixtures, so you can prove your connector works **with no live
account**.

```ts
// packages/connectors/test/contract/my-connector.test.ts
import { describeConnectorContract } from '@chorus/connectors/testing'
import { createMyConnector } from '../../src/my-connector/index.js'

describeConnectorContract('my-connector', () => createMyConnector(), {
  // Optional. Each one you supply buys the assertions below it.
  scenarios: {
    rateLimited: () => createMyConnector({ cassette: 'rate-limited' }),
    credentialExpired: () => createMyConnector({ cassette: 'expired' }),
  },
  webhookSample: () => ({ request: recordedDelivery, secret: RECORDED_SECRET }),
})
```

A factory, not an instance: each case gets a connector no earlier case has
already advanced, so the suite cannot pass or fail depending on the order it ran
in.

`scenarios` and `webhookSample` are optional because the kit cannot make an
arbitrary source produce a rate limit on demand, and a suite no contributor
could pass would be worse than a visible gap. Omitting one means those
guarantees are simply **untested** for your connector — which is a gap anyone
can see, not a hidden pass.

Supply `webhookSample` if you can. The kit forges your sample delivery itself,
which is the assertion worth having: a `verify` that returns `true`
unconditionally passes every test written against valid input.

### What the kit checks

| Area | Guarantee |
|---|---|
| Declaration | kind is in the catalogue; auth spec valid; capabilities non-empty; `source` implies `pull` |
| Normalisation | every signal parses against the envelope; `source` matches `kind` |
| Provenance | non-empty external id; `raw` present; a usable `occurredAt` |
| Pagination | ids unique within a page; terminates with a null cursor; resuming returns what follows |
| Rate limits | reported as `RateLimitedError` with a positive `retryAfterMs` *(needs `scenarios.rateLimited`)* |
| Health | states are valid; a failure names a problem **and** a remedy; uses the injected clock |
| Webhooks | spec and handler present together; a genuine delivery verifies and has an id; a tampered body or wrong secret does not; handled signals parse; the same delivery yields the same ids *(needs `webhookSample`)* |

### Not yet covered

**OAuth token refresh.** Still nothing performs it. The GitHub connector
authenticates as an App installation, which is a different mechanism — the
framework hands a connector `ctx.saveCredentials` for exactly this, and the
guarantee joins the kit alongside the first connector that refreshes a token
(GitLab or Linear), rather than being written now as a promise nothing enforces.

## Cassettes

A cassette is a JSON file of recorded interactions living in `__cassettes__/`
beside its connector. `cassettePlayer(name)` returns a `fetch` that answers from
one; hand it to your connector through `ctx.fetch`.

Two rules make them worth having:

- **An unmatched request is an error, never a 404.** A player that answered
  "not found" for a request nobody recorded would turn a connector bug into a
  silently empty result and a passing test. Matching is on method and full URL,
  including the query string — a connector asking for `?per_page=100` where the
  cassette recorded `?per_page=30` would paginate differently against the real
  API, and a lenient match would hide exactly that. It caught a malformed-query
  bug in the GitHub connector on its first run.
- **Nothing is committed unredacted.** `cassetteRecorder` strips authorization
  headers, cookies and signatures on the way in, so redaction is the same code
  every time rather than something each contributor remembers.

The GitHub cassettes currently in the tree are **hand-authored from GitHub's
published response shapes**, not recorded against a live installation — nobody
has run this against github.com. They are faithful about the shape the connector
must parse and claim nothing more. Re-recording them with `cassetteRecorder`
against a real installation is a worthwhile follow-up for anyone who has one.

---

## The reference connector

`src/reference/` is a deliberately simple, scriptable connector. It exists to
keep this interface honest before a real API distorts it, and to let the kit
demand behaviours a real source will not produce on request — an expired
credential, a rate-limit response, a run of pages that ends.

It ships in `src/`, not in a test file, because a kit that only ran against
test-local fixtures would not demonstrate that the interface is implementable by
somebody else. Read it first; it is short, and it is the shape yours should be.

---

## Testing your connector

```bash
pnpm test --grep INT-1        # the framework's own guarantees
pnpm vitest run --project contract packages/connectors
```

Record cassettes rather than calling a live source. A test that needs an account
is a test nobody else can run, and CLAUDE.md §7 is explicit that a cassette must
never carry real credentials or customer data — redact before you commit.
