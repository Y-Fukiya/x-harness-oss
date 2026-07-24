# ADR-012: Human-approved interaction watch contract

- Status: Implemented for read-only monitoring and candidate display; X writes deferred
- Date: 2026-07-24

## Context

An operator wants to monitor one specified X account, review each newly detected
original post, and explicitly approve one Like plus one Repost. Detection may be
periodic, but it must never create an X write.

The read-only milestone is explicitly approved. X's April 2026 automation rules
prohibit automated Likes. Consequently, polling may only create review
candidates, and neither polling nor an agent may approve or execute an X action.

## Decision

The runtime uses the least-privilege
`XInteractionWatchReadAdapter` for detection and
`XInteractionWatchPublishingAdapter`, which extends `XPublishingAdapter`, for
future named-human delivery. A poller receives only the read contract. The
implemented Worker routes, Cron processor, D1 migration, and operator UI expose
registration, detection, and candidate display only. No runtime implementation
of `XInteractionWatchPublishingAdapter` exists.

A future implementation must satisfy all of these conditions:

1. Exactly one active watch is permitted. Registration accepts one username,
   resolves it to a numeric user ID through X, and verifies the returned
   username before persistence.
2. Polling uses a read-only adapter, advances from a durable cursor, excludes
   replies and Reposts, stores no post body, and only creates pending candidates.
3. A named operator opens the exact X post and individually confirms the
   candidate-bound `like_and_repost` operation. Cron and agents cannot approve
   or execute it.
4. The candidate ID, post ID, operation ID, approval ID, operator ID, and
   approval timestamp are bound into one short-lived proof. IDs use distinct
   opaque types.
5. The intent is persisted before the first X write. Once the Like request
   starts, every error or interruption is `outcome_unknown` with
   `retryAllowed: false`; reconciliation is human-only.
6. Every mutation is append-only audited without post bodies, credentials,
   personal information, or approval proof contents.
7. Emergency stop is fail-closed. The feature has its own default-disabled
   production flag, fresh-D1 staging fake smoke evidence, release approval,
   privacy-review reference, and rate policy. Its release is mutually exclusive
   with every X-write release and uses a dedicated application-only read Bearer
   Token rather than any User Context write credential.
8. Production release requires a fresh review of X's current Automation Rules.
   If individually initiated Likes are no longer permitted, the Like portion is
   removed rather than bypassed.

## Consequences

The system can detect and display candidates without creating an executable
engagement feature. Any later X-write implementation remains a separate
explicit milestone, must be developed against fake adapters, and must never
contact X from tests.
