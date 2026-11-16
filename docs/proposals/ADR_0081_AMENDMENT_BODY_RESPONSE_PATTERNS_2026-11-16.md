# ADR-0081 amendment: body-response patterns in memory (draft)

Status: draft. Owner's ruling 7 of 16 Nov 2026 (waldoco/waldo-app#257, comment 6926736096): the nightly review may read body data and store a words-only pattern, on staging behind a switch. Such a pattern is never a value, can be corrected and forgotten, and is kept only under the owner's health consent. Production stays off until this amendment and the consent wording are accepted.

## What changes in ADR-0081's destination matrix

| Destination | Before | After (with `MEMORY_BODY_PATTERNS`) |
|---|---|---|
| Memory claims | Only what the owner said about their health. Never a wearable reading, never an inferred condition. | Also a **body-response pattern**: Waldo's inferred, untrusted claim about how the owner's Recovery or Form tended to be after a kind of outcome. It is written in zone words, across at least three outcomes, never with a number, a condition, a diagnosis or a cause stated as fact. |

Every other destination is unchanged. Raw values stay in the health store. Tool numbers stay in the turn. No score, driver or reading is ever passed to the review.

## What the review reads, and when

- It reads the outcomes it already reads: decided cards and closed loops since its mark.
- Beside each outcome, it reads the owner's Recovery and Form **zone words** for the day the outcome ended and the next day. These come from `waldo.health_zones_read` (20261106120000), the read personal experiments already use:
  - zone words only;
  - only rows whose consent basis is live for model use;
  - never a backfilled row.
- The body is read only when all three hold:
  1. the deploy's `MEMORY_BODY_PATTERNS` is on (staging only until this is accepted);
  2. the owner shares health with memory (the memory health setting);
  3. the owner's model-processing consent is live for the row's source. The read enforces this.
- If the read fails or answers in another shape, the review goes on without the body and logs `body_unread`. Nothing about the body is guessed.

## What is stored

- A claim of kind `health`, with source `inferred` and origin `untrusted` (outside grounding). It quotes the outcome lines it rests on. Example: "Recovery tended to be mixed or compromised the day after evening workouts Waldo moved; held for 3 of 4."
- The numeric health floor refuses any claim that carries a number tied to a health word, as it does for every memory write.
- **Correctable and forgettable:** it is an ordinary claim. The owner can confirm, correct or dismiss it, and "forget" removes it and holds its topic against being re-added.
- **Consent:** withdrawing model processing stops the read the next night. Turning off health in memory removes health claims from the review's adds (`withoutHealthClaims`), and the existing health-memory setting governs whether stored health claims are kept.

## Consent wording (draft for the app)

Under the memory health setting:

> **Let Waldo learn how your body responds.** Waldo can notice patterns between the changes it suggests and how your recovery and readiness looked afterwards, for example that your recovery tends to dip after late workouts. It remembers these in words, never numbers, as its own guess until you confirm it. You can see, correct or delete each one, and turning this off stops it.

Privacy notice row:

| Data | Why | Where it is kept | Who processes it | How long |
|---|---|---|---|---|
| Patterns between Waldo's suggestions and your recovery and readiness, in words | To plan with how your body tends to respond | Your Waldo memory | Waldo; the AI model provider during the nightly review, only with your model-use consent | Until you delete it or turn off health in memory |

## Rollout

1. Staging: `MEMORY_BODY_PATTERNS` on for the owner's and the team's accounts, after the outcomes caller is wired (Ark's lane: the nightly line and the `outcomeClaims` responder, behind `MEMORY_OUTCOME_LEARNING`).
2. Production: only after this amendment is accepted and the consent line is in the app.

## Evidence Trail

- 2026-11-16 · Ansh's session · Drafted after ruling 7. It reuses the existing model-consented zones read rather than adding a migration (why: the read already gives words only under model consent, and one migration fewer reaches the owner's morning list).
