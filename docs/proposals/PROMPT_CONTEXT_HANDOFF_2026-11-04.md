# Prompt and context engineering: handoff, 4 Nov 2026

Status: stopped early on the orchestrator's instruction (fewer parallel lanes). The work moves to Ansh. No code was changed, no switch was added and no evals were run.

Base: beta-mvp `8455b0b96`. Branch: `claude/prompt-context-v2` (this file only).

## Brief (from the orchestrator, for Ansh)

1. Write `docs/architecture/HARNESS_MAP_2026-11-04.md` from source. Cover every layer from an event or message to its delivery:
   - admission and inboxes, triggers and wakes, the router/owner turn, task workers and machine jobs;
   - the tool loader, the context composer, the prompt builder, memory and recall, approvals and the effect ledger;
   - delivery per surface, the scheduler and alarms, and observability.

   For each piece, name the file, contract, switch, model and token cost per round. Mark where the DeepSeek ideas land and which lane owns each:

   | Idea | Owner |
   |---|---|
   | Full-duplex | `harness-full-duplex` |
   | Chain of Recall | `chain-of-recall` |
   | Watchdog | `progress-watchdog` |
   | Tools | `tool-engineering` |
   | Thread routing and the health action layer | after #1840 |

2. Prompt audit: remove contradictions, duplication and stale rules. Add per-channel style guidance (chat short, email and docs structured) as guidance plus evals. Add proactive behaviour: ask only what is the owner's to decide, plan, propose, and act within grants with receipts and undo.
3. Context audit:
   - Measure what each turn type injects, and how stable the cache prefix is on Anthropic and OpenAI.
   - Apply Inline & Spill.
   - Cut waste and add what the model is missing.
   - Show before/after tokens and cache hit rate on recorded evals.
4. Constraints:
   - ADR-0081: zone words only.
   - No credentials in prompts.
   - The Scribe rules stay.
   - Contracts are additive only.
   - Put behaviour changes behind `WALDO_PROMPT_V2`: "1" in staging, "0" in production.

## What was read

Read so far: `packages/runtime/src/prompt/messaging-behavior.ts`, `prompt/turn-prompt.ts` and `prompt/fixed-lines.ts`.

Not read yet:
- `prompt/day-cards.ts`, `update-cards.ts`, `reasons.ts`, `machine-jobs.ts` and `fit-prompt.ts`;
- `health/trigger.ts`;
- `context-composer/*`, `skills/loader.ts`, `tools/loader.ts` and `conversation/tool-loop.ts`;
- the voice docs.

## Findings so far

All findings come from that read of the source at `8455b0b96` and are [verified] unless tagged.

1. **The voice text is pinned by a test.** `messaging-behavior.ts:8-10` says "a test pins the text to the version" (`VOICE_VERSION = 4`). The owner ruled against wording protections on 1 Nov. [proposed] Drop the text pin and keep the version and changelog as documentation; this was not checked against the test file itself.
2. **Every surface is told it is "in a messaging app".** `IDENTITY` (`messaging-behavior.ts:6`) says so, and the "Short" bullet in `VOICE` (line 15) applies to every surface. No per-channel style guidance exists. This is where chat-vs-email/docs guidance belongs. [proposed] Make it a surface-keyed paragraph after the stable head, or in the surface presentation, so the cache prefix stays per-surface stable.
3. **The same rules appear twice on the direct path versus the surface path:**
   - Connection and console links: `DIRECT_DOING` (line 102) and `surfacePresentationPrompt` (line 162).
   - Calendar and email proposal rules: lines 104-105 and line 163.

   The two copies differ in wording. [proposed] Keep one source of truth for each rule.
4. **The near-medicine rule is stated twice.** It appears in the last `VOICE` bullet (line 30) and in `HEALTH` (lines 109-112). The two agree, but it is duplication.
5. **Asking rules overlap in three places:** `VOICE` "Ask almost nothing" (line 25), `TASKS` "Ask only for what is still unknown" (line 48), and "Asking" (lines 55-59). They are consistent, so the fix is a candidate merge, not a contradiction. The proactive brief ("ask only what is the owner's to decide") fits here.
6. **The India site list is a fixed list.** It is in `TASKS` (line 72). [inference] It could come from the owner's locale or memory instead. Keep it in mind against the judgment-to-model rule. It is guidance, not a gate.
7. **Cache layout is already designed for prefix stability.** In `turn-prompt.ts`, the system prompt is behavior + skill catalog + standing orders + REASONS fixed layers, with a loaded procedure after the stable head. Per-turn facts (clock, today, profile, memory, health, loops, connections, task context) ride the owner message as one fenced turn context.
   - `assembleTurnPrompt` already returns byte counts per section (`sections`, `contextSections`). This is the measurement hook for task 3.
   - [inference] In harness tool mode, the tool catalogue sits in the system prompt (`messaging-behavior.ts:136-146`). Any change to the tool set therefore moves the cache prefix. Check this with the tool-engineering lane.
8. **No issue found in `fixed-lines.ts`.** It is model-free owner text, used only when no model can be reached. This is legitimate under the judgment rule.

## Next steps for Ansh [proposed]

- Start the harness map from `channels/owner-do.ts` (5.8k lines), `channels/owner-turn.ts`, `conversation/tool-loop.ts`, `tools/dispatcher.ts`, `scheduler/multiplexer.ts`, `context-composer/composer.ts` and `llm/provider.ts`.
- Measure context per turn type from the `sections`/`contextSections` byte counts on recorded evals before changing anything.
- Coordinate with the sibling lanes before editing:
  - tool-engineering owns tool descriptions and results;
  - chain-of-recall owns recall refs;
  - full-duplex owns owner-turn structure.
