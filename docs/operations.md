# CUBΣLIC Phase 1 Operations

## Operating boundary

Phase 1 creates, reviews and measures content. It does not publish, schedule, delete, like, repost, follow, reply or send DMs on X. Approval writes an inert adapter inbox row only. The Phase 1 build keeps this boundary even if `CUBELIC_SAFE_MODE=false` is supplied; keep it `true` as an operational assertion and for preflight visibility.

Production also contains the separately approved DG-024 Phase 3 boundary. It
does not reopen legacy X Harness write routes: only
`POST /api/cubelic/drafts/:id/publish` may perform an immediate text post after
named-human approval, and only reviewed `category:template_id` policies may
enter the CUBΣLIC scheduler. Media delivery, deletion, DMs, replies, likes,
follows and engagement automation remain unavailable. The current production
D1 emergency stop is active, so both Phase 3 publication and scheduling are
disabled until a separate human resume decision.

The event-bound content-ingestion operation window is also an X-publication
stop. While that window is active, immediate publication, new scheduling, and
Cron delivery remain disabled even if the D1 emergency stop is temporarily
resumed for approved event/master ingestion. Closing the window re-engages the
D1 stop.

## Initial setup

1. Copy the variable names from `.env.example` into the deployment secret store. Never commit values.
2. Apply `packages/db/migrations/018-cubelic-content-os.sql`,
   `019-cubelic-fail-closed-boundaries.sql`,
   `020-cubelic-phase3-publication.sql`, then
   `021-cubelic-publication-reconciliation.sql`, then
   `022-cubelic-operation-window-publication-lock.sql`, then
   `027-cubelic-media-delivery.sql`, then
   `028-cubelic-human-x-interactions.sql` to a backed-up D1 environment.
3. Set `X_HARNESS_ACCOUNT_ID` to the selected `x_accounts.id`; do not use the public username.
4. Keep `HERMES_RUNTIME_ENABLED=false` in Phase 1 and do not provision Hermes runtime credentials. If a later reviewed release enables it, give Hermes only `HERMES_ACCESS_TOKEN` (the MCP process prefers it over `X_HARNESS_API_KEY`). Give approval UI operators `HUMAN_APPROVAL_KEY`; never expose it to Hermes.
5. Set `CORS_ALLOWED_ORIGINS` to the exact HTTPS approval-UI origin(s), comma-separated; wildcard origins fail closed.
6. Run `corepack pnpm check` before deployment.
7. Run `corepack pnpm preflight:production`; do not deploy while it reports placeholders or missing secret names.

## Daily flow

1. Import the human-approved song/member masters, then ingest an event and its setlist/media metadata through the versioned contracts. Unknown/inactive song ids and title mismatches fail closed.
   Run `pnpm validate:production-inputs` first. Configure `RESOLVE_EXPORT_ALLOWED_ROOTS` with the approved absolute parent directories; test fixtures, known fixture placeholders, nonexistent roots, allowlist escapes and symlink escapes are rejected without printing local paths. The gate also verifies event/song/master links and hashes the actual Resolve media file before accepting the bundle.
2. Validate media and rights evidence. Unknown or expired evidence blocks generation/approval.
3. Generate up to three deterministic drafts. Inspect quality, freshness, privacy and similarity flags.
4. An admin/editor reviews `/cubelic`, edits if needed, then approves with the human approval key.
5. For an approved Phase 3 schedule, select the approved draft in `/cubelic` and enter the operator time in Asia/Tokyo. The UI converts it to UTC and binds the policy id to that draft's `template_id`; operators do not type an independent policy id.
6. Confirm the audit event and resulting inert handoff, schedule job, or publication job. A publication remains a named-human action; an automated schedule is limited to the exact reviewed `category:template_id` pair.
7. After publication, record the numeric post id with `POST /api/cubelic/metrics/post-mappings` using human approval proof. Metrics collection rejects unmapped post ids, and summaries join the post back to category, member, song, event, fan stage, template, variant and emotion dimensions.

Media delivery remains a separate capability. Keep
`CUBELIC_PHASE3_MEDIA_ENABLED=false` until migration 027, the dedicated
`CUBELIC_MEDIA` R2 binding, and staging media smoke are complete. A validated
asset is staged with `PUT /api/cubelic/media/:assetId/body`, exact
`Content-Type`, `Content-Length`, and `X-Content-SHA256` headers. This route may
only be called by a named human operator; Hermes has no raw-media-write access.
MP4 ingress is limited to 95,000,000 bytes. Raising that limit requires
verification of the deployed Cloudflare plan or a reviewed direct/multipart R2
ingress design.
Keep `MEDIA_RETENTION_POLICY_VERIFIED=false` until a bounded R2 lifecycle rule
and the named-human incident quarantine/delete runbook have been exercised.
For an incident, first activate the emergency stop, then call
`POST /api/cubelic/media/:assetId/quarantine` with named-human approval proof.

## Named-human interaction requests

These routes remain disabled until migration 028 and the separately reviewed
interaction release gates are complete:

- `POST /api/cubelic/interactions/reply`
- `POST /api/cubelic/interactions/dm-reply`
- `POST /api/cubelic/interactions/like`
- `POST /api/cubelic/interactions/follow`
- `POST /api/cubelic/interactions/unfollow`

Every request uses a unique `operationId` and `approvalId`, an `approvedAt`
timestamp no older than ten minutes, the named staff credential,
`X-Human-Approval-Key`, and `X-Interaction-Approval-Proof`. Compute the latter
as lowercase hex HMAC-SHA256 with `HUMAN_APPROVAL_KEY` over:

`interaction-approval:v1:{request_sha256}:{staff_id}`

Provision `INTERACTION_FINGERPRINT_KEY` as a distinct random secret of at least
32 characters. Only the Worker uses it to produce domain-separated persisted
HMAC fingerprints; never expose it to the browser or operator. Set
`INTERACTION_FINGERPRINT_KEY_VERSION` to the reviewed deployment version. The
first request pins a non-secret key commitment and that version in D1. Never
change either value in place: disable interactions and complete a reviewed D1
migration/duplicate-domain reconciliation before any rotation.

`request_sha256` is lowercase hex SHA-256 of the server-canonical JSON object
with these exact key orders:

- reply: `kind`, `operationId`, `approvalId`, `approvedAt`, `targetPostId`,
  `text`, `inboundOrMentionAttested`, `operatorId`
- DM reply: `kind`, `operationId`, `approvalId`, `approvedAt`,
  `conversationId`, `inboundMessageId`, `text`, `recipientInitiated`,
  `operatorId`
- like: `kind`, `operationId`, `approvalId`, `approvedAt`, `targetPostId`,
  `operatorId`
- follow/unfollow: `kind`, `operationId`, `approvalId`, `approvedAt`,
  `targetUserId`, `operatorId`

Never log the canonical JSON, proof, target, conversation, inbound event, or
message body. The operator UI should compute the proof locally only after its
explicit one-operation confirmation.

Reply requests require `inboundOrMentionAttested: true`. DM reply requests
require `recipientInitiated: true` and the exact `inboundMessageId`. Unknown
fields are rejected, and the same inbound post/DM event cannot be used with a
new operation id. If a response reports `interaction_outcome_unknown`, inspect
X read-only and do not issue a replacement operation.
The route writes intent and completion audits around R2 deletion; the immutable
D1 mapping remains as evidence and all later delivery attempts fail closed.
The production preflight refuses media activation while this evidence is false.
The first staging proof uses `CUBELIC_PHASE3_MEDIA_SMOKE_MODE=true` only with
`ENVIRONMENT=staging` and `staging_fake` delivery. Turn it off immediately
after the proof; production rejects this mode.
The existing publish/schedule routes revalidate the immutable D1/R2 mapping
before any X upload.

## Emergency controls

- `POST /api/cubelic/admin/emergency-stop` blocks all CUBΣLIC mutation except metrics collection.
- A missing or malformed database emergency-stop flag is treated as stopped, but
  `GET /api/cubelic/admin/status` reports `emergencyStopValid: false` so an
  operator cannot mistake corruption for a healthy stop. New installations start
  with a valid stopped row.
- `POST /api/cubelic/admin/emergency-resume` requires a human approval key and an admin.
- All legacy X and administration routes are unavailable in the Phase 1 Worker, including X-backed GET routes. `GLOBAL_PUBLISHING_DISABLED=true` remains an independent deployment assertion.
- Follow [incident-response.md](incident-response.md) whenever a boundary or rights concern is discovered.
- An X timeout or ambiguous response must remain `publishing`; never retry it
  automatically. Follow “Publication outcome unknown” in
  [incident-response.md](incident-response.md). DG-026 reconciliation is
  available only to a named human through
  `POST /api/cubelic/admin/publications/:jobId/reconcile` while the D1
  emergency stop is active. The same operation is available in `/cubelic` by
  entering the incident-recorded job id; published times are entered in
  Asia/Tokyo and normalized to UTC. It performs no X write and leaves the stop
  active.

## Read-only production safety check

Run `pnpm verify:production-safety:keychain` from the approved production Mac
before and after a release or incident repair. It reads the staff API key from
macOS Keychain without printing it and fails unless the D1 stop row is valid and
active, publishing and scheduling are disabled, and no operation window is
active. Other environments can use `PRODUCTION_WORKER_URL=...`
`PRODUCTION_API_KEY=... pnpm verify:production-safety` through an approved
secret-bearing shell.

## Rollback

Set the emergency stop first, then roll the Worker/UI back to the last known version. The migration is additive; do not drop tables during an incident. Preserve append-only audit rows and export relevant D1 records before any repair.

Production GAS payload shape, Resolve path and other deferred integration inputs remain tracked in [Decision-Grill.md](Decision-Grill.md). The production topology and X Harness account mapping are resolved.
