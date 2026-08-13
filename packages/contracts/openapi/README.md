# Waldo Public API artifact

`waldo-public-api.json` is generated from the backend contract source. It is a static contract
artifact, not evidence that a route is enabled or deployed. Responsibility operations are disabled
unless `RESPONSIBILITY_PUBLIC_API_ENABLED` is exactly `true`.

## 0.2.0 migration record

Version 0.2.0 replaces the artifact's two planned or unserved paths with the five guarded
responsibility routes implemented by the current Worker. The removed paths are:

- `GET /public/v1/briefs/morning/current`
- `POST /v1/engagement-events`

Downstream validation on 2026-08-13 found Morning Brief references in `Pin4sf/waldo-app` planning
and status documents. Those documents explicitly classify the operation as planned and not
implemented. No Waldo App runtime implementation was found. Organization code search found no
consumer of the engagement path outside this backend's former OpenAPI source and artifact.

This change does not retire the Morning Brief product direction. Before Waldo App integration, its
plan must be reconciled with a backend route that is implemented, versioned, and independently
verified. Consumers that intentionally use the former static contract must remain pinned to the
pre-0.2 artifact until that reconciliation is complete.

Rollback before merge is to close or revert the B0 pull request. After merge, revert the 0.2
contract commit and regenerate the artifact and SHA sentinel. No deployment or data migration is
part of this contract change.
