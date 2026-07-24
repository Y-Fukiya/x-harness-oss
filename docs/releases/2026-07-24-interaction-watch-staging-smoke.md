# Read-only interaction-watch staging smoke — 2026-07-24

## Outcome

The default-disabled read-only monitoring boundary passed its dedicated
staging-fake smoke. No X API call or X write was made. Staging finished with the
D1 emergency stop active and every interaction-watch flag disabled.

## Migration and rollback

- Migration: `029-x-interaction-watch-queue.sql`
- Pre-migration backup:
  `/private/tmp/x-harness-staging-before-029-20260724.sql`
- Backup SHA-256:
  `1d7a71996c95f478bc620ab44bdd9de430e0ae9674c9783374167b7bf2b7077a`
- Backup mode: `0600`
- Post-migration state: one synthetic watch and one ID-only synthetic candidate
  retained as append-only smoke evidence

## Smoke evidence

- Smoke Worker version: `21f98128-badd-43cd-ac88-4479dcf8e0b7`
- Final disabled Worker version: `b61a818a-ba0f-41d8-bb5e-929119d0c70f`
- One original synthetic post was detected
- One synthetic reply and one synthetic Repost were excluded
- The second poll discovered zero candidates
- Candidate storage and API output contained IDs and timestamps only
- Candidate table had no `body` or `text` column
- X-write audit count after watch registration: zero
- The D1 emergency stop was restored to exact `true`
- Final Worker health check returned HTTP 200

## Final staging state

- `X_INTERACTION_WATCH_ENABLED=false`
- `X_INTERACTION_WATCH_SMOKE_MODE=false`
- `X_INTERACTION_WATCH_RELEASE_APPROVED=false`
- `X_INTERACTION_WATCH_STAGING_SMOKE_VERIFIED=false`
- `X_INTERACTION_WATCH_PRIVACY_REVIEW_APPROVED=false`
- Empty privacy-review and reviewed-target bindings
- All named-human interaction flags disabled

Production activation remains separate. It requires a real target-bound privacy
review, a dedicated application-only read credential, an explicit release
approval, and the production migration and deployment while every X-write
release remains disabled.
