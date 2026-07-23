# ADR-011 — Named-human X interaction boundary

- Status: Accepted as a default-disabled later-phase capability
- Date: 2026-07-24

## Context

DG-030 approves only one-by-one actions initiated and separately approved by a
named human. It does not approve automated replies, proactive DMs, automated
likes, bulk or discovered targets, automated following, Cron execution, or
Hermes execution. X delivery must remain behind an adapter and production
enablement requires a separate release review.

## Decision

Expose five single-operation REST endpoints for reply, recipient-initiated DM
reply, like, follow, and unfollow. Every request requires a named staff
credential and the separate human-approval proof. The executing staff identity
is also the individual approver. The interaction proof is an HMAC over the
canonical request fingerprint and operator identity; it is distinct for every
approved action, expires after ten minutes, and is consumed once.

`XHumanInteractionAdapter` is the only X delivery boundary. It rejects a
disabled capability, active emergency stop, non-individual authority, or
operator/approver mismatch before calling its writer. Hermes has no route
allowlist entry and Cron has no interaction executor.

Migration 028 stores only the operation id, action kind, request fingerprint,
non-reversible interaction/approval fingerprints, operator id, and state. It
does not store the target, body, or external X/DM result id. Audit
snapshots contain no target, conversation id, message
body, or approval-secret content. Reusing an operation id with different
content is rejected. A completed retry is read-only; an executing or
outcome-unknown retry is stopped for human reconciliation and is never sent
again automatically.
All three persisted fingerprints use domain-separated HMAC-SHA256 with the
dedicated `INTERACTION_FINGERPRINT_KEY`; plain request or target hashes are not
stored. The Worker pins a non-secret commitment and explicit
`INTERACTION_FINGERPRINT_KEY_VERSION` in D1 before the first operation. A key
or version mismatch fails closed before delivery. Rotation therefore requires
a separately reviewed migration that preserves or deliberately migrates the
existing deduplication domain; changing a secret alone is not a rotation
procedure. D1 triggers make this key state append-preserved, keep interaction
identity columns immutable, and allow only one `executing` to terminal
transition.

Replies require a request-bound named-human attestation that the target is an
inbound post or account mention. DM replies require both a recipient-initiation
attestation and the exact inbound DM event id. The non-reversible interaction
fingerprint is unique, so changing the operation id cannot send a second
response to the same inbound post or DM event. Unknown JSON fields, including a
valid scalar target combined with a bulk array, are rejected.

The capability requires all of:

- `CUBELIC_HUMAN_INTERACTIONS_ENABLED=true`
- `HUMAN_INTERACTIONS_RELEASE_APPROVED=true`
- `STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED=true`
- a configured delivery mode
- a strong dedicated `INTERACTION_FINGERPRINT_KEY`
- an explicit `INTERACTION_FINGERPRINT_KEY_VERSION`
- both emergency stops disengaged at request time

Staging and production configuration keep all three interaction flags false
until that separate review is completed.
Before that flag exists, the dedicated staging fake runtime may temporarily set
`CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE=true`. Production always rejects smoke
mode.

## Consequences

- Manual one-by-one operations have a testable, fail-closed path.
- Existing legacy automation routes remain compile-time blocked.
- DM initiation, recipient discovery, bulk input, and background execution are
  not represented by the adapter.
- An ambiguous network outcome requires a future, separately reviewed
  reconciliation ceremony; it cannot be retried through the endpoint.
