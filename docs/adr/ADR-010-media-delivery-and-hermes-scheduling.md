# ADR-010 — Add reviewed media delivery and least-privilege scheduling

- Status: Accepted
- Date: 2026-07-23

## Context

The approved publication boundary previously supported text only. Validated
media records referenced local export paths, which a Worker cannot read, and
media upload identifiers issued by X are short-lived external identifiers.
Hermes could generate and inspect drafts through the least-privilege API but
did not expose the already-approved scheduling seam through its MCP contract.

## Decision

Add a separate, default-disabled `CUBELIC_PHASE3_MEDIA_ENABLED` capability.
Only an existing `approved_for_draft` asset whose rights and privacy review
still pass may be streamed to a dedicated R2 binding. The request must declare
an exact lowercase SHA-256 digest, allowlisted MIME type, and bounded content
length. R2 verifies the checksum while accepting the fixed-length stream. D1
stores one immutable R2 mapping and its append-only audit.

Supported delivery sets are up to four JPEG/PNG/WebP images, or one GIF, or one
MP4 video. Images are bounded to 5 MiB, GIF to 15 MiB, and Worker-ingested MP4
to 95,000,000 bytes so the complete request stays below the deployed Workers
request-body ceiling. Larger videos require a separately reviewed
direct/multipart R2 ingress.
GIF/video delivery uses bounded ranged R2 reads and X chunked upload, so the
Worker never buffers the full object. The X post is created only after every
media upload succeeds. A job is persisted as `publishing` before external
delivery. Each X media upload has a durable append-only intent before the
external request and a result containing the X media id immediately after a
successful response. A failed pre-post step deterministically fails the job;
an explicit X 4xx create-post rejection also fails deterministically. Only a
network failure, timeout, X 5xx, or otherwise ambiguous create-post outcome
continues to require human reconciliation. An intent without a result identifies a possible orphan upload
for incident review. A timeout or X 5xx during media upload is recorded as
`publication.media_outcome_unknown` and remains unresolved until expiry or
reconciliation evidence exists; unattached X upload sessions are not retried
automatically.

Hermes receives one new `cubelic_schedule_draft` MCP tool. It calls the existing
schedule route and therefore can act only on a human-approved draft matching an
exact reviewed category/template policy. Hermes receives no approval,
immediate-publication, emergency-resume, X credential, or direct-X tool.

## Consequences

- Migration 027 and a dedicated R2 binding are required before media staging.
- Both staging and production remain disabled until their explicit media flag
  is enabled after media-specific smoke and retention/quarantine verification.
- A staging-only smoke mode may temporarily authorize the first proof with
  `staging_fake` delivery; production rejects this mode and still requires both
  evidence flags. Fake delivery reads the same bounded R2 chunks and writes the
  same upload intent/result audits without calling X.
- Revoked rights, missing R2 metadata, duplicate asset ids, invalid media sets,
  missing checksums, and malformed sizes fail closed.
- Text-only publication and scheduling behavior is unchanged.
- The media flag must remain disabled until a bounded R2 retention rule and a
  named-human incident quarantine/delete procedure are configured and verified.
