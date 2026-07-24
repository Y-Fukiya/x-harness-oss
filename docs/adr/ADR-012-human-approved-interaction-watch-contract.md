# ADR-012: Human-approved interaction watch contract

- Status: Accepted as a future-milestone contract; runtime implementation deferred
- Date: 2026-07-24

## Context

An operator wants to monitor one specified X account, review each newly detected
original post, and explicitly approve one Like plus one Repost. Detection may be
periodic, but it must never create an X write.

The active milestone permits later behavior only as interfaces and
documentation. X's April 2026 automation rules also prohibit automated Likes.
Consequently, neither polling nor an agent may approve or execute the action.

## Decision

The public type contracts are the least-privilege
`XInteractionWatchReadAdapter` for detection and
`XInteractionWatchPublishingAdapter`, which extends `XPublishingAdapter`, for
named-human delivery. A poller must receive only the read contract. No Worker
implementation, route, Cron registration, database migration, operator UI, or X
client call is included in Phase 1.

A future implementation must satisfy all of these conditions:

1. Exactly one active watch is permitted. Registration accepts one numeric user
   ID and verifies its username against X before persistence.
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
   production flag, staging fake smoke evidence, release approval, and rate
   policy in addition to the existing named-human gates.
8. Production release requires a fresh review of X's current Automation Rules.
   If individually initiated Likes are no longer permitted, the Like portion is
   removed rather than bypassed.

## Consequences

Phase 1 can compile and review the boundary without creating an executable
engagement feature. Advancing the active milestone is a separate explicit
decision. That later implementation must be developed against fake adapters and
must never contact X from tests.
