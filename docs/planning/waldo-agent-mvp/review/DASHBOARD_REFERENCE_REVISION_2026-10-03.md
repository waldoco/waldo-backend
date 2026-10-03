# Dashboard reference revision: first reviewable slice

Issue: https://github.com/waldoco/waldo-backend/issues/656
Base: #562 at e93fb78990e43fda911e83e0e3ab05a69b6d9fcb. No deploy.

## Observed references

- https://andrewtrousdale.com/: warm paper, fine asymmetric branching, small distinct symbols, orange focus, side index/inspector. This informs presentation only, not relationships or narrative.
- https://www.figma.com/design/Dl0WP9uIvx6QbSzZi7cZQY/Waldo?node-id=619-9181: quiet pale sidebar and cards, serif hierarchy, restrained controls. Its example numbers and health cards are not data contracts; later ontology rules still govern.

## First slice

Memory tab/record hierarchy and controls. Constellation uses thin segmented saved branches, wrapped labels, orange focus and a quieter serif inspector. Mobile keeps map typography readable with an independently scrollable map, centered initial focus, scroll hint, inspector beneath and the unchanged returned-link list. It does not shrink the graph into unreadable type.

All association/support filtering, counts, partial/withheld notices, removal semantics, detail links, keyboard activation and finite reduced-motion-aware settling remain. A displayed branch is not verified evidence. No new relationship is inferred from layout. No shared auth, DO, entrypoint or signin changes.

## Verification and limits

Dashboard tests and production build pass. Synthetic screenshots inspect desktop (1440) and mobile (390), including branch map, inspector and Spots hierarchy. Browser geometry confirms page content stays within the viewport and horizontal overflow is confined to the map. Reduced motion was enabled for stable evidence.

This is a reviewable visual slice, not owner visual acceptance and not the full dashboard's final design approval. #562 remains a stale integration base relative to beta-mvp. Existing legacy preservation and current main changes need separate reconciliation before promotion. No hosted staging, production, live tenancy or provider behavior is proven by synthetic previews. Overview/onboarding/Connections and supplied deck/Home copy are not revised in this slice.
