# Interaction boundary production deployment — 2026-07-24

## Outcome

Migration 028 and the reviewed Worker code were deployed to production while
the named-human interaction capability remained disabled. No production X
interaction was executed.

## Database

- Pre-migration backup:
  `/private/tmp/x-harness-production-before-028-20260724.sql`
- Backup SHA-256:
  `8f1485476908bf8db3c3c6a0fcbffd4fa5a79ae99d7947e985ecbfb9b94fb77e`
- Migration: `028-cubelic-human-x-interactions.sql`
- Post-migration verification: two tables, four interaction triggers, clean
  foreign-key check
- Emergency-stop row remained valid and active

## Credentials

The dedicated production fingerprint key is stored in macOS Keychain as
`X Harness Production Interaction Fingerprint Key` and registered as the
Worker secret `INTERACTION_FINGERPRINT_KEY`. Its value was not printed or
committed. The configured version is `2026-07-24-v1`; D1 will pin its
non-secret commitment only after a separately approved first interaction.

## Worker deployment

- Previous version: `c475da89-eeb0-4ce0-bb05-318ba3662133`
- Deployed version: `73f626f3-e905-4a5a-be68-5ded109e2e71`
- Custom API health/status: HTTP 200
- Production safety verification: passed after deployment propagation
- D1 emergency stop: active
- Immediate publishing: inactive while stopped
- Scheduling: inactive while stopped
- Media delivery: disabled
- Named-human interactions: disabled
- Interaction smoke mode: disabled

The deploy provisioned the configured dedicated production media bucket
because it did not yet exist. The media capability and all of its release
gates remain false, so provisioning the binding did not enable media delivery.

## Remaining gate

Production interaction activation still requires an explicit release decision.
That deployment must set both the release approval and staging-smoke
attestation together, keep production smoke mode false, run production
preflight, and execute only one separately approved named-human canary before
normal operation.
