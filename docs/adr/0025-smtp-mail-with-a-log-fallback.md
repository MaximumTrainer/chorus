# ADR-0025: Mail goes over SMTP when a relay is configured, and to the log when it is not

- **Status:** Accepted
- **Date:** 2026-11-19
- **Requirement:** NFR-1 (#132) AC1
- **Decided by:** Dan, on the decision card "How should a deployed Chorus send sign-up and invitation emails?" (option "SMTP, with log fallback")

## Context

Sign-up requires a verified email address (WS-1), and invitations and
checkpoint notifications are sent by email (WS-2, SLACK-6). Until #277 the
API's entrypoint passed no mail transport at all. Without one, `createApp` does
not mount `/auth/*`, so nobody could sign in to a running deployment. #277 added
a **log transport**: each message, with its single-use link, is written to the
API's standard error. That lets the operator, who is the first person to sign up
anyway, get in on a fresh `docker compose up`. A log is not delivery, though,
and nobody else on a team can be expected to read the API's logs to find their
invitation.

The options were:

1. **SMTP, with the log as the fallback.** Real mail wherever a relay is
   configured; a fresh install with no relay still works.
2. **Log only, for now.** No new dependency, and real delivery left for later.
3. **SMTP required.** The API refuses to start without a relay.

## Decision

Option 1. When `CHORUS_SMTP_URL` is set, mail is sent over SMTP; when it is not,
it goes to the log, and the API warns once at boot that this is happening.

- **One URL configures it**, `smtp://user:pass@host:587` or `smtps://…:465`.
  This is the form relays document, and a single variable cannot be half-set.
  `CHORUS_MAIL_FROM` names the sender. It defaults to
  `Chorus <no-reply@<CHORUS_BASE_URL's host>>`.
- **Transport: [nodemailer](https://nodemailer.com/)**, pinned at 6.9.16, in
  `apps/api` only. It has no runtime dependencies of its own, handles STARTTLS
  upgrade, implicit TLS, AUTH mechanisms and pooling, and is the default SMTP
  client in the Node ecosystem. Hand-writing an SMTP client is the kind of
  protocol code CLAUDE.md §7 warns against: the edge cases (dot-stuffing, line
  length, 8BITMIME, TLS negotiation) are exactly where a homemade one fails.
- **A failed send throws.** The caller decides what that means. Sign-up reports
  it. Notifications record it as a failed delivery and retry through the queue
  (§11.8). A transport that swallowed the failure would turn a broken relay into
  mail everyone believes was sent.

Option 3 was rejected because NFR-1 AC1 requires `docker compose up` on a clean
host to reach a working system. Option 2 was rejected because nobody but the
operator reads the API log.

## Consequences

- One new runtime dependency, in one package. A relay's credentials live in
  `CHORUS_SMTP_URL`, so on Fly it is a secret (`fly secrets set`), never
  `[env]`.
- Mail is proven against `startFakeSmtpServer` (`packages/testing`), a real TCP
  SMTP server speaking the RFC 5321 subset a client needs. The tests assert on
  what crossed the wire, not on what the transport object reports.
- While no relay is configured, the API log carries live sign-up and invitation
  links, so it is as sensitive as an inbox for the minutes those links are
  valid.
- The worker's notification delivery still has no mail transport of its own.
  Wiring the same transport there is a follow-up.
