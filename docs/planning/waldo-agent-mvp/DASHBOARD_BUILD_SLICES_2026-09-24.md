# Dashboard build slices (2026-09-24) - executable breakdown of spec v2.1

Each slice: bounded scope, Figma-visual verification criteria, exit. Executor: Claude on the Mac under lane spec; lane reviews diff before deploy. Visual verification is pixel-level against the Figma frames, not "close enough": screenshot the built surface, compare layout/spacing/hierarchy against the frame, fix, re-verify before reporting done.

- **D1 Auth seam (prerequisite)**: B1 minted dashboard link + session list + sign-out-everywhere (BUILD_ORDER NEXT items 3-4). Exit: link from Telegram lands signed-in; double-redeem = one session; sign-out-everywhere kills all.
- **D2 P0 shell**: app frame, greeting + weather, setup checklist (Folk activation pattern). Visual: match onboarding/home frames. Exit: owner opens /console from a minted link, checklist shows real connection state (channel linked, calendar connected, quiet hours set).
- **D3 P0 today surface**: briefs + handoff card + protected day plan. Visual: match the home/today frames. Exit: today's brief renders from real brief data; handoff card shows pending approvals and they act.
- **D4 P1 memory explorer**: spots + constellations over STM/LTM, claim facets (stated/confirmed/inferred + machine facet when the bridge lands). Visual: match explorer frames. Exit: owner finds a claim, sees its provenance + evidence, corrects and forgets from the UI (P2 wires the mutations; D4 is read + correct/forget if trivial).
- **D5 P1 patrol activity log + insight card**: what Waldo did and noticed. Exit: a real approval + a real spot appear in the log with traces.
- **D6 P2 trust mutations**: handoff approvals in-dash, quiet hours, autonomy level, scoped + granular deletion, account deletion (delete_owner RPC + adversarial deleted-means-deleted probe). Exit: an approved calendar move lands and shows in the patrol log; deletion probe passes.
- **D7 usage + cost surface**: per-service usage and spend. Exit: today's LLM + connector calls render with real numbers.

Sequencing: D1 gates everything (no auth, no dashboard). D2-D3 are the owner-visible core. D4-D7 parallelizable once D1 lands.
