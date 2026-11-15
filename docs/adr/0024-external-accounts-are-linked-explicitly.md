# ADR-0024: A person's account at a source is linked explicitly, never matched by email

- **Status:** Accepted
- **Date:** 2026-11-13
- **Requirement:** NFR-4 (#135) AC1, AND1; completes the viewer-scope half of #242

## Context

Restricted content from a source — a Confluence page readable only by the
finance group — is captured onto its signal as a permission scope
(`confluence:group:finance`), and retrieval and the brain map show it only to a
user holding that scope (`source_scope_memberships`, §10.5). A membership sync
reads who is in the group at the source. What it then needs is the answer to
"which Chorus user is this Atlassian account?" — and a wrong answer shows a
restricted page to the wrong person, which is precisely the failure NFR-4 exists
to prevent.

Chorus's own sign-in is the organisation's identity provider (generic OIDC), not
Atlassian, so nothing already links the two. The options were:

1. **Match by email** — the Atlassian account's email against the user's
   verified Chorus email. Works on day one for company-managed accounts, but an
   Atlassian user can hide their email, two systems' notions of "the same
   address" drift (aliases, case, plus-addressing, a reassigned mailbox), and a
   match is an inference the person never confirmed.
2. **Explicit link only** — each person signs in at Atlassian once from Chorus
   and so proves which account is theirs.
3. Both, with an explicit link overriding a match.

## Decision

**Option 2. A person's account at a source is linked only by that person
proving they own it; it is never inferred from an email or any other matching
attribute.** Decided by the product owner on 2026-11-13.

- The proof is an OAuth authorization-code flow with PKCE against the source
  (`ExternalIdentityProvider`, a port in `core`; `createAtlassianIdentity` in
  `packages/connectors`). Only identity is requested (`read:me`), and only the
  account id is kept — the tokens used to learn it are discarded.
- The flow is built against the account-linking attack, in which an attacker
  starts a link and tricks another signed-in person into completing it, binding
  the victim's account (and its group access) to the attacker. A link request is
  stored server-side bound to the person who started it, its state hashed and its
  PKCE verifier never in a URL; it completes only for that same signed-in person,
  who must still be a member; it is consumed on first presentation, whatever the
  outcome; and it lapses after ten minutes. A request completed by anyone else is
  refused before the code is ever exchanged.
- One account per person per provider, and one person per account in a
  workspace: two people cannot both claim an account and both inherit its access.
- Unlinking removes the link and, in the same transaction, the person's
  memberships from that provider's sources — access ends at once, not at the next
  sync (AND1). Linking and unlinking are audited.

## Consequences

- No one gains access to restricted source content until they have linked their
  own account. That is slower to roll out than email matching, and deliberately
  so: the cost of a missing link is a person who sees less, while the cost of a
  wrong match is a person who sees what they must not.
- The membership sync keys on linked accounts only. A group member who has not
  linked gains nothing; there is no fallback.
- Each further source (Slack, Google Drive, …) adds an identity provider and an
  entry in `PROVIDER_SCOPE_SOURCES`, not a new mechanism.
- Starting and removing a link are session-only: a token, which is lent to
  software, can never widen what a person can see.
