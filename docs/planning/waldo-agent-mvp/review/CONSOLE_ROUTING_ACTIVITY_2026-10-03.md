# Routing and recorded activity follow-up

Base: beta-mvp f0b1de03d6d52fdd4f24de35a152e71c816b0f6c (#674).

Verified both reported findings on a synthetic Chromium render of this base: unknown hash showed Today, while update_card / joined_path / llm_reply appeared as raw headings in Patrol and update_card in Today.

Unknown nonempty routes now resolve to an explicit Page not found destination, with Open Today recovery. The invalid hash remains inspectable until navigation; it no longer misrepresents Today. Empty route and overview alias retain Today; invalid Memory and Settings selectors keep their existing specific recovery.

Known activity headings now describe operations: Update card, Conversation processing, Chat reply. Source semantics checked in update-card logging, owner-turn joined path processing and harness Chat reply mapping. Unknown kinds get Recorded activity, not a guessed effect. Raw kind remains in collapsed Technical details on Today and Patrol traces/runs. Saved nonempty summaries are preserved; null or whitespace summaries explicitly say no outcome was recorded, without implying delivery or an external change. This does not add missing backend summaries or prove a provider outcome.

Red-first: unknown route resolution, mounted invalid-hash/recovery, Today label and missing-outcome language, Patrol known/unknown labels with raw disclosure. 181 tests / 22 files, TypeScript/Vite build, asset verification pass. Chromium synthetic Today/Patrol/not-found rendered at 1440 and 390, inspected mobile crops and desktop not-found; body widths match viewport. No staging writes, deployment, auth, or backend edits.
