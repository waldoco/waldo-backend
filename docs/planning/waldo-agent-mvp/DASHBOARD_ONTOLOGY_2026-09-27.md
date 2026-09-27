# Waldo Dashboard - Ontology of Record & Copy Rules (owner-settled 2026-09-27)

Status: OWNER-SETTLED. Source: owner's answers to the lane's six terminology questions (2026-09-27 12:47pm), the Home copy structure draft v2 (owner-supplied), and heywaldo.in. The owner's close: "we will do technical analysis for terminologies but for now these are good estimates." Card copy in the Figma does NOT define metrics.

## Scores

- FORM: 0-100 readiness for cognitively demanding activity. Accepted formula: 50% Sleep + 35% HRV + 7.5% Circadian + 7.5% Motion. Sleep and HRV required plus at least one of Circadian/Motion; missing optional components renormalize; insufficient inputs produce "unavailable", NEVER a made-up score. Deterministic, versioned backend calculation - never model-invented. Meeting load is NOT a Form input; card commentary is broader than score inputs. Allowed sources (contract, not proof of live integrations): HealthKit/Apple, Oura, WHOOP, validated Samsung.
- LOAD: cardiovascular demand today; 0-21 scale, log-scaled, heart-rate-weighted training impulse; resets at midnight. Newer flows place Load UNDERNEATH Today's Weight.
- TODAY'S WEIGHT: the broader combined demand across life and work (Body/Schedule/etc.). "The Stack" = meeting/schedule demand component.
- Naming note: the Home copy draft refers to "the three scores (Recovery, Form, Weight)"; the owner's ontology answers use Form/Load/Weight. Resolve display naming with him if both surfaces ship.

## The Slope

Six dimensions: Body, Schedule, Communication, Tasks, Tone, Screen. "Five of six" means five trending ADVERSELY. Show only when all six have usable comparable data. Time-horizon inconsistency (4-week vs 7-day) is UNRESOLVED.

## Communication metrics

- SIGNAL PRESSURE: communication volume x response pressure x after-hours ratio. Conceptual, metadata-based only (never message content), not versioned.
- TEAM PINGS: no formal definition; interpret as work-chat activity (primarily Slack). Needs a counting rule before it becomes a metric - do not infer one from card copy.

## The Patrol

The record of what Waldo noticed, decided, did, or deliberately did NOT do - with a reason and an outcome. Includes suppressed alerts and skipped briefs. User-facing activity/decision history; NOT a raw internal event dump, NOT just notifications. Named action vocabulary (Brief, Fetch, Adjustment, Ask...) per the Home draft's "10 named actions" (details live on How-it-works).

## Status chips (display taxonomy)

- Form zones (ACCEPTED, July ADR, supersedes April 80/65/50): Energized 80-100 / Steady 60-79 / Flagging 40-59 / Depleted 0-39. A later "Very High..Very Low" UI draft has no agreed mapping - the backend contract wins.
- Protected: window state, not readiness.
- Slope direction: Declining / Improving / Holding / Mixed - vocabulary defined, no numerical rule yet.
- Drooping: provisional Figma UI wording, not a metric state.

## The Window

Official name for the protected focus block (maps "Focus Time"). Target: >=90 uninterrupted minutes in the strongest Form hours. Distinguish "window found/proposed" from "window protected". Calendar mutations are approval-gated per the conflict ledger.

## Copy and tone rules (Home draft v2, binding for dashboard voice)

- Headlines Corben with hand-set tapering line breaks; sections end on an italic aside; CTA wording "Let Waldo in ->".
- AI is the world Waldo lives in, never an adjective for Waldo.
- No health outcome promises, no medical claims: health is context for decisions, not treatment.
- No number without a source.
- Trust model copy: three-position switch (Tell me / Ask me / Just do it) - maps to the shipped act_and_report / confirm_first gates; "undo it in one tap" and "reads metadata, never what your messages say" must be literally true wherever used.

## Design posture (owner steer, 2026-09-27 1:00pm)

"Tone down the health aspect if it reads too much like a health app / health agent." Waldo is a health-AWARE assistant, not a health-tracker UI. Concretely for the dashboard/console reskin:

- Health appears as narrative CONTEXT inside the Overview (the morning card, the brief timeline: "your sleep was short by about 90 minutes" as prose), not as a wall of per-metric cards.
- No metrics-wall IA on the console home. A dedicated Health Stats surface, if one ships, is a separate quiet screen - never the landing impression.
- Status chips stay semantic and sparse: they mark state (Form zone, Protected window), they do not turn the console into a wearable dashboard.
- Copy follows the Home rule: health is context for decisions, never medical claims, never the headline.

## Unresolved (owner acknowledged)

1. Team Pings counting rule.
2. Slope calculation and time horizons.
3. Backend-state-to-display-chip mapping beyond the Form zones.
4. Recovery vs Form display naming (Home draft vs ontology answers).
