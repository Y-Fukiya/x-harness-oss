# Phase 1 Deployment Checklist

## Before staging

- Resolve every production-blocking input in `docs/Decision-Grill.md` or record its approved staging substitute.
- Create separate staging D1, Worker and Web resources.
- Keep `cubelic-fan.com` on its existing fan-site Pages project. Deploy the operator UI as a separate Pages project at `ops.cubelic-fan.com`; never deploy `apps/web/out` to the fan-site project.
- Protect `ops.cubelic-fan.com` with Cloudflare Access before granting operator access.
- Replace the Worker URL, D1 database id and X Harness account-row placeholder.
- Provision distinct `API_KEY`, `HUMAN_APPROVAL_KEY`, `SESSION_SIGNING_KEY`,
  `STAFF_KEY_PEPPER`, and `CREDENTIAL_ENCRYPTION_KEY` secrets. The credential
  encryption key must be 32 random bytes encoded as base64url. Keep
  `HERMES_RUNTIME_ENABLED=false` and do not provision `HERMES_ACCESS_TOKEN` in
  Phase 1; if a later release enables the Hermes runtime, its token becomes
  required and must be distinct.
- For CI, provision a least-privilege `CLOUDFLARE_API_TOKEN`. For a manual release using Wrangler's encrypted OAuth store, run `wrangler whoami` for the intended account and only then set `CLOUDFLARE_AUTH_VERIFIED=true` in the release shell.
- Keep `CUBELIC_SAFE_MODE=true`; give Hermes neither the API admin key nor the human approval key.
- Configure `INTERACTION_FINGERPRINT_KEY_VERSION` even while named-human
  interactions remain disabled. Before a later enablement, provision the
  corresponding dedicated fingerprint key; never rotate the key or version
  without a reviewed D1 migration that preserves the deduplication domain.
- Configure an allowlisted production CORS origin before exposing the approval UI.
- Production CORS must be exactly `https://ops.cubelic-fan.com`; the public fan-site origin is not an operator origin.
- Keep `PRODUCTION_CONTENT_INGEST_ENABLED=false` for the base Phase 1 infrastructure release. Import the human-approved `cubelic.song-master.v1` and `cubelic.member-master.v1` contracts before any production setlist.
- Run `pnpm preflight:production`; it reports names only and never prints secret values.
- Set `PRODUCTION_INPUTS_VALIDATED=true` only after contract validation succeeds. Set `PRODUCTION_LP_MAPPING_VALIDATED=true` only after a human approves the authoritative event-to-LP route and confirms the LP update state. Both attestations are required before enabling `PRODUCTION_CONTENT_INGEST_ENABLED=true`. Set `STAGING_SMOKE_VERIFIED=true` only after the staging smoke succeeds.

## Staging validation

1. Run `pnpm check`, apply `018-cubelic-content-os.sql`,
   `019-cubelic-fail-closed-boundaries.sql`,
   `020-cubelic-phase3-publication.sql`, then
   `021-cubelic-publication-reconciliation.sql`, then
   `022-cubelic-operation-window-publication-lock.sql`, then
   `023-staff-key-hashes.sql`, then `024-line-connections.sql`, then
   `025-credential-key-state.sql`, then `026-external-mutation-idempotency.sql`,
   then `027-cubelic-media-delivery.sql`, then
   `028-cubelic-human-x-interactions.sql`
   to staging D1, then run
   `STAGING_WORKER_URL=... STAGING_API_KEY=... pnpm smoke:staging` from an
   approved secret-bearing shell. Smoke must observe
   `emergencyStopValid: true`; a missing or malformed D1 stop row is a failed
   deployment even though runtime mutations still fail closed.
2. Import redacted master fixtures, then ingest a redacted real GAS setlist and confirm exactly one Content Item plus no more than three drafts; an unknown id/title must be rejected.
3. Ingest a redacted real Resolve sidecar and verify duplicate hash, rights and privacy failures.
4. Confirm Hermes cannot edit, approve, reject, stop/resume, schedule or publish.
5. Confirm an editor/admin without `X-Human-Approval-Key` cannot approve.
6. Approve with a named human and confirm exactly one inert inbox row and no X post/schedule id.
7. Activate both database emergency stop and `GLOBAL_PUBLISHING_DISABLED=true`; verify all non-metrics writes and every legacy route (including X-backed GET requests) fail.
8. Rotate all staging secrets after the exercise.

## Production release

- Build the operator UI with `NEXT_PUBLIC_MAINTENANCE_MODE=true` until the production Worker and secrets pass smoke verification; only then rebuild with the flag set to `false`.
- Back up D1, apply migrations 023, 024, 025, and 026, verify the backup is readable, then
  deploy Worker and Web. The first authenticated login migrates all legacy
  credentials; verify only counts and encrypted prefixes, never print values.
- Verify the operator Pages project and custom-domain target are distinct from the existing `cubelic-fan` project before deploying Web.
- Verify Cloudflare Access denies an unauthenticated request to `ops.cubelic-fan.com` before sharing the URL.
- Check `/api/capabilities` and `/api/cubelic/admin/status` before operator access.
- Run `pnpm verify:production-safety:keychain` and require a valid active D1
  stop, disabled publishing/scheduling, and no active operation window.
- Keep the first production run manual: one source, one reviewed draft, one inert handoff, no automated X action.
- Before that run, validate the six-contract bundle and event-specific LP attestation, then run `pnpm operate:production:check` with both emergency stops active. Open a separately reviewed operation window (`GLOBAL_PUBLISHING_DISABLED=false`), set `PRODUCTION_OPERATION_WINDOW_OPEN=true` and `PRODUCTION_OPERATION_CONFIRMED` to the exact approved event id, then run `pnpm operate:production:first-run`. The server binds writes to that event for at most 30 minutes; the active operation window independently blocks immediate X publication, new schedules, and Cron delivery while the D1 stop is temporarily resumed. Ingest failure and the first successful inert handoff re-engage the D1 stop. Restore the environment stop immediately after handoff.
- Record release commit, operator, migration result and rollback point in the audit/release record.

### External mutation reconciliation

If an external mutation returns `outcome unknown`, do not repeat it with a new
operation ID. An admin must first inspect the target system using its read-only
UI or API and record one of these outcomes:

1. If the object exists, call
   `POST /api/line-connections/{connectionId}/operations/{operationId}/reconcile`
   with `confirmation: "verified_external_state"`, `outcome: "completed"`, and
   the bounded JSON response needed by the caller.
2. If the object definitely does not exist, call the same route with
   `confirmation: "verified_external_state"` and `outcome: "not_completed"`.
   Only then may the original request be retried.
3. If the target state cannot be proven, leave the operation unresolved and
   escalate it. Never guess or issue a replacement mutation.

Both reconciliation outcomes are restricted to an authenticated admin and are
append-only audited. Response bodies used for replay are encrypted at rest.
- If any boundary differs from staging, activate emergency stop and follow `docs/incident-response.md`.

## Phase 3 publication release

Phase 3 is default-disabled. Do not combine its first enablement with unrelated migrations or UI changes.

1. Apply migrations `020-cubelic-phase3-publication.sql`,
   `021-cubelic-publication-reconciliation.sql`, and
   `022-cubelic-operation-window-publication-lock.sql`, then
   `027-cubelic-media-delivery.sql`, then
   `028-cubelic-human-x-interactions.sql` to staging and keep both
   stops active.
2. Configure `CUBELIC_PHASE3_DELIVERY_MODE=staging_fake` only on the dedicated staging Worker, then configure exact reviewed `category:template_id` pairs in `CUBELIC_PHASE3_SCHEDULE_POLICIES`. Only `event_notice`, `event_reminder`, and `youtube_notice` may be allowlisted.
3. Set `CUBELIC_PHASE3_ENABLED=true` and `GLOBAL_PUBLISHING_DISABLED=false` in staging, then use the human approval key to resume the D1 stop.
4. Create a named admin/editor staff credential and sign in with that staff API key. The shared environment `API_KEY` may inspect the system but cannot attest manual production input, approve a Phase 3 draft, or publish immediately.
5. Verify an unapproved draft, mismatched operator, missing rights/privacy/link proof, non-allowlisted policy pair, past schedule time, daily/weekly limit, and minimum interval are rejected.
6. Publish one text-only staging fixture through the fake/staging X destination and verify one `publication.started` plus one `publication.completed` audit. A media request must fail with `media_delivery_disabled` until the separate media release gates are satisfied.
7. Schedule one allowlisted fixture through Hermes and verify Cron claims it once. Stop the system before another due run and verify no X call occurs. Simulate an X timeout and verify the job remains `publishing` with `publication.outcome_unknown`, never an automatic retry.
8. Set `STAGING_PHASE3_SMOKE_VERIFIED=true` only after the preceding checks pass.
   For a later media release, separately stage an allowlisted fixture as a named
   human, deliver it through staging fake mode, verify the upload intent/result
   audits, exercise the incident quarantine/delete runbook and bounded R2
   lifecycle rule, then set `STAGING_PHASE3_MEDIA_SMOKE_VERIFIED=true` and
   `MEDIA_RETENTION_POLICY_VERIFIED=true`. During this staging-only exercise,
   set `CUBELIC_PHASE3_MEDIA_SMOKE_MODE=true`; turn it off before recording the
   evidence. Production rejects this smoke mode. The recommended production
   policy expires `media/` objects after 30 days, aborts incomplete multipart
   uploads after seven days, begins incident quarantine within 15 minutes, and
   verifies deletion within one hour.
9. Run production preflight with `CUBELIC_PHASE3_ENABLED=true`, `CUBELIC_PHASE3_DELIVERY_MODE=x`, `GLOBAL_PUBLISHING_DISABLED=false`, `PHASE3_RELEASE_APPROVED=true`, the reviewed policies, and `STAGING_PHASE3_SMOKE_VERIFIED=true`. Production must reject `staging_fake`.
10. Back up D1, apply migrations 020, 021, 022, 027, and 028, deploy Worker, verify Cron and
    `/api/cubelic/admin/status`, then deploy the operator UI.
11. Resume the D1 stop only when a named operator is present. Publish one human-approved text draft, verify the returned X post manually, and keep the emergency-stop control visible throughout.
12. Keep `CUBELIC_HUMAN_INTERACTIONS_ENABLED=false`,
    `HUMAN_INTERACTIONS_RELEASE_APPROVED=false`, and
    `STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED=false` until a separate
    one-by-one interaction smoke and production release review are recorded.
    For the first smoke only, use the dedicated staging fake Worker with
    `CUBELIC_HUMAN_INTERACTIONS_SMOKE_MODE=true`; turn it off before recording
    `STAGING_HUMAN_INTERACTIONS_SMOKE_VERIFIED=true`. Production must keep the
    smoke-mode flag false. A successful generic staging smoke is not reusable
    approval for production: enable one-by-one interactions only for a concrete
    target with a named operator, a fresh operation-bound proof, and same-window
    verification of the required X User Context scope.
