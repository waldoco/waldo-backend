# Waldo Health Lane - Workflows & Coaching Spec (owner verification draft)

Status: DRAFT for owner verification. No code in this PR. Origin: owner steer 2026-09-27 10:21am ("we are going health first... define various workflows and out of the box flows and intelligence around that and the overall coaching and planning... an assistant who is going to be health aware").

## Foundation already shipped

Health-logging MVP lane (W7): biometric background cron, silent wearable logging, Telegram health-coach behavior (proactive morning brief, weekly review, plan generation with tailoring, lightweight day/N-day pattern context). This spec defines the workflow and intelligence layer on top, plus the connector roadmap.

## Data sources (staged)

S0 - manual Telegram logging (shipped): meals, workouts, sleep notes, weight.
S1 - apple-healthkit + google-health-connect: phone-side connectors; spec now, land with the app (owner's call this morning). Steps, HR/HRV, sleep stages, workouts, body metrics.
S2 - function-health: lab panels - ingest results, plain-language explanation inside the medical gate (below), trend tracking across draws.
S3 - healthex: health-data aggregation where it complements the above.

## Out-of-box flows

1. Onboarding health profile: goals (strength/fat-loss/endurance/sleep), constraints (injuries, conditions to be aware of, diet), equipment and schedule, preferred check-in times. Stored in profile-facts/health memory; editable anytime.
2. Morning brief (daily, shipped in MVP - extend): sleep/readiness summary, today's plan (workout, meals, hydration), one nudge tied to the active goal.
3. Pre/post workout: pre - today's session with warmup and modifications for logged soreness/injury; post - log prompt, next-day adjustment.
4. Meal flow: photo or text log -> estimate + macro tally vs daily target; dinner-time recap if targets far off.
5. Weekly review (shipped in MVP - extend): adherence, trends (weight, sleep, volume), next week's plan adaptation, one coaching observation.
6. Lab-results flow (S2): new panel -> summary of what's in/out of range in plain language, what changed since last draw, questions to ask a doctor. Never diagnosis - see medical gate.
7. Plan generation & adaptation: goal + constraints -> weekly plan; each weekly review adapts based on adherence and trends.

## Intelligence layer

- Planning loop: plan -> log -> review -> adapt, on the cron + review cadence already shipped.
- Pattern context: lightweight day/N-day rollups (shipped); extend to cross-domain (poor sleep -> lighter session suggestion; high stress note -> recovery day).
- Coaching voice: owner-tunable tone; concise Telegram-length messages; nudges are suggestions, never nagging - frequency caps.
- Health-aware assistant: health context available to the general assistant lane (e.g., scheduling respects training days; travel planning considers sleep) - read-only context, consented.

## Medical gate (absolute, unchanged)

Non-diagnostic always: no condition claims, no medication advice, symptoms get a clinician redirect, emergencies get emergency guidance. Lab explanations are informational with a see-your-doctor frame. This gate is never weakened by any workflow above (standing constraint).

## Constraints

- Synthetic data only in every probe/test (standing constraint). No real health data in traces, logs, or reports.
- Per-source consent before any connector reads; revocation honored immediately.
- Phone-side sources (S1) land with the app; nothing here blocks the Telegram-only S0 lane.

## Open owner decisions

1. S1 connector priority vs the app's own timeline.
2. Lab provider: function-health first, or keep S2 generic until a provider is picked.
3. Coaching frequency caps and default check-in times (proposed: morning brief 7am, weekly review Sunday evening - confirm).
