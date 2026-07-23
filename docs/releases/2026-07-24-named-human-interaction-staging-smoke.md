# Named-human interaction staging smoke — 2026-07-24

## Outcome

The default-disabled interaction boundary passed its dedicated staging-fake
smoke. No X API call was made. Staging finished with the D1 emergency stop
active and both interaction feature flags disabled.

## Source and migration

- Feature commit: `08fd033`
- Temporary smoke configuration commit: `8c22330`
- Final disabled configuration commit: `31bc4fe`
- Upstream PR merge: not required and not performed
- Pre-migration backup:
  `/private/tmp/x-harness-staging-before-028-20260724.sql`
- Backup SHA-256:
  `58537e8a6900ddca7994c46f00d535a6d6b438eaabd77398c4497d2ce5227efb`
- Migration: `028-cubelic-human-x-interactions.sql`
- Post-migration verification: two tables, four interaction triggers, clean
  foreign-key check

The dedicated staging fingerprint key is stored in macOS Keychain as
`X Harness Staging Interaction Fingerprint Key` and registered as the Worker
secret `INTERACTION_FINGERPRINT_KEY`. Its value was not printed or committed.
The pinned D1 version is `2026-07-24-v1`; the stored non-secret commitment has
the required 64-character length.

## Smoke evidence

- Worker smoke version: `5c84af9f-00d8-42c1-b9b2-450118d57ea9`
- One fake reply completed
- One fake recipient-initiated DM reply completed
- One fake like completed
- One fake follow completed
- One fake unfollow completed
- Replaying the completed reply was idempotent
- A bulk-shaped request was rejected
- A stopped request was rejected
- Audit counts: five `interaction.started`, five `interaction.completed`, one
  `interaction.fingerprint_key_initialized`
- No target, conversation, or body was queried for the release record

## Final staging state

- Worker version: `4710a0c0-fcb6-43f1-b512-d44a36a158ec`
- Health: HTTP 200
- Emergency-stop row: valid and active
- Named-human interaction status: disabled
- Interaction probe while stopped: HTTP 423
- `CUBELIC_HUMAN_INTERACTIONS_ENABLED=false`
- `CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE=false`
- `HUMAN_INTERACTIONS_RELEASE_APPROVED=false`
- `STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED=false`

The successful evidence is recorded here rather than leaving a stale
attestation flag active. A later production release must explicitly review
this evidence and update both release gates in the same reviewed deployment.
