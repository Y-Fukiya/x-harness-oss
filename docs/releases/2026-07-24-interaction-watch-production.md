# Read-only interaction-watch production activation — 2026-07-24

## Outcome

Production now monitors exactly one explicitly selected, privacy-reviewed X
account for new original posts. The initial read created nine pending review
candidates. Candidate storage contains IDs and timestamps only; post bodies are
not persisted.

## Release boundaries

- Phase 3 publication: disabled
- Named-human X interactions: disabled
- Media delivery: disabled
- Read-only interaction watch: enabled
- X application-only credential: Worker Secret and macOS Keychain
- Reviewed numeric target binding: Worker Secret, absent from committed vars
- D1 emergency stop: intentionally resumed for the isolated read-only poller
- Poll interval: at least 15 minutes
- Poll limit: at most 96 attempts per UTC day
- Cron: every five minutes; the D1 reservation policy suppresses polls inside
  the minimum interval

The read-only resume route first proves the complete watch configuration. An
incomplete or mixed X-write configuration cannot resume this mode.

## Approval and policy evidence

- Separate production release approval: the operator explicitly requested the
  production watch steps and then selected the exact target on 2026-07-24.
- Privacy review reference: `privacy_review_watch_20260724_v1`. It records that
  exact operator-selected username; X resolved the same username, and the
  resulting numeric ID was bound as a secret to prevent later handle takeover.
- Fresh policy review: X's official Automation Rules were re-read on
  2026-07-24 (`https://help.x.com/en/rules-and-policies/x-automation`, page
  updated April 2026).
- Review result: read-only detection and human review links remain in scope.
  Automated Likes remain prohibited and are not implemented. No automated
  Repost capability was enabled.

## Verification

- Full `pnpm check`: passed
- Standard tests: 291 passed
- D1 integration tests: 49 passed
- Dedicated activation-script tests: three passed
- Keychain-backed production preflight: passed
- Production Worker deployment: completed
- Production active-watch count: one
- Production pending-candidate count after initial poll: nine
- A second Cron poll completed after the 15-minute interval with no failure
- X-write audit count since watch registration: zero
- Operator Pages deployment: completed
- Both the custom operator origin and the direct deployment returned the
  Cloudflare Access unauthenticated redirect

## Rollback

1. Invoke the audited D1 emergency stop.
2. Set every interaction-watch release flag to `false`.
3. Restore `GLOBAL_PUBLISHING_DISABLED=true` when no other reviewed release is
   active.
4. Deploy the stopped Worker configuration.
5. Revoke the application-only credential and remove both watch secrets if the
   rollback is credential- or privacy-related.
