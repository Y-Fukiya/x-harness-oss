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

## Verification

- Full `pnpm check`: passed
- Standard tests: 288 passed
- D1 integration tests: 49 passed
- Dedicated activation-script test: passed
- Keychain-backed production preflight: passed
- Deployed code version:
  `a031b5ba-a993-48f6-86c6-caaeed570dfa`
- Latest secret-change version:
  `7b8813a8-8f8a-4c81-aabd-10434c605171`
- Production active-watch count: one
- Production pending-candidate count after initial poll: nine
- X-write audit count since watch registration: zero
- Operator Pages deployment:
  `https://67e9a635.cubelic-ops-production.pages.dev`
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
