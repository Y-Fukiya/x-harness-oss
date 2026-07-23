# Media delivery staging smoke — 2026-07-24

## Outcome

The default-disabled media boundary passed its dedicated staging-fake smoke.
No X API call was made. Staging finished with the D1 emergency stop active,
the media capability disabled, and the staged R2 object quarantined.

The upstream pull request was not merged or modified.

## Database preparation

Migration `027-cubelic-media-delivery.sql` had not been applied to either
deployed D1 database even though the disabled Worker code referenced it.
It was applied with the exact emergency-stop row active.

- Staging backup:
  `/private/tmp/x-harness-staging-before-027-20260724.sql`
- Staging backup SHA-256:
  `c1cd1802a9beccffeb9cea0e7e8af4321907fae21d8c40e2d9a5541579d39fd3`
- Production backup:
  `/private/tmp/x-harness-production-before-027-20260724.sql`
- Production backup SHA-256:
  `bd1f0ea2f48c35663c4f2fd77df24e44a4c19f297bbff906924fa01a16d85751`
- Both backups were restored into local SQLite databases and passed
  `PRAGMA integrity_check`
- Both deployed databases contain one media-object table, three immutable or
  fail-closed triggers, and no foreign-key violation
- Both deployed databases retained the exact active emergency-stop value

Production media delivery remained disabled throughout.

## R2 retention

The staging media bucket has two active lifecycle rules:

- incomplete multipart uploads abort after seven days
- objects under `media/` expire after one day

The one-day staging rule bounds forgotten smoke artifacts. No production
retention period was inferred or configured; that remains a release-policy
decision.

## Staging smoke evidence

- Temporary smoke Worker version:
  `61b8b624-e4f4-4aed-b3de-e21859fa86fd`
- Final disabled Worker version:
  `17278bff-49c6-4d0e-9745-b9156f0b8e99`
- Production disabled Worker version:
  `4ec04f90-25a6-4efb-86e7-8e8a4346ae1e`
- One checksum-bound PNG was written through the immutable R2 staging route
- The staging-fake adapter read the stored object and completed one fake
  immediate publication
- Audit counts include one media-object staging event, one upload intent, one
  upload result, one quarantine start, and one quarantine completion
- The quarantine route verified that the R2 object no longer existed
- The D1 emergency stop was restored and remained valid
- No credential, post body, media body, target, or evidence content was
  printed or added to this record

The reusable smoke command is `pnpm smoke:staging:media`. It is restricted to
the exact dedicated staging hostname and reads both operator credentials from
macOS Keychain.

## Template safety

Generated publication templates no longer hard-code a brand name or hashtag.
Event-specific title or venue text also makes staging fixtures distinct so
the duplicate-content guard remains active without making repeated smoke runs
impossible.

## Final state

- Staging media delivery: disabled
- Staging media smoke mode: disabled
- Production media delivery: disabled
- Production media smoke mode: disabled
- Staging D1 emergency stop: active
- Production D1 emergency stop: active
- Production R2 retention approval: pending
- Post-deployment production safety verification: passed with the exact D1
  stop active and publishing, scheduling, media delivery, and the operation
  window closed
