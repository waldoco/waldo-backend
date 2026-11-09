# Workspace referent checkpoint

Source base: beta-mvp f0b1de03d6d52fdd4f24de35a152e71c816b0f6c. Serving config inspected from the exact deployed tree; no model, billing, provider grant or flag change.

## Serving route and limits

The default deployed two-argument TelegramOwnerDO constructor uses the scoped legacy owner responder, not private canonical preparation. `WALDO_CHAT_MODEL` and the default memory model are `gpt-6-luna`. Replies, read-only delegated children, day planning, constellation, reactions, memory extraction, nightly memory and migration use that OpenAI route. The adapter pins reasoning to `low` with an automatic reasoning summary, 30-second timeout and no SDK retries. Each call reserves at most 4096 output tokens. The owner policy has no fallback and no escalation; template fallback is disabled. Main and child loops share 25 tool rounds per submitted turn. This is not a total call or dollar cap: other processing and context-degradation attempts exist. Conversation history has a 100000 estimated-token share cap; system and tool context are additional.

Source: contracts/model/roster.ts; runtime/channels/telegram-owner-do.ts:183,1422; runtime/channels/owner-turn.ts:78,132,179,245,395,576,671-719; runtime/llm/openai.ts:35,40,68; runtime/conversation/window.ts:15.

The separate formal roster assigns Gemma 4 26B primary/auxiliary, Sonnet 4.6 reasoning and Haiku 4.5 fallback/judge. Its configured tier ceilings are free=zero escalations, pro=3/day and pro_max=70 cents/day; Anthropic DPA flag is false. These are not evidence that the deployed Telegram route uses or enforces that ladder. STT options are ElevenLabs Scribe v2, smallest Pulse and OpenAI gpt-4o-mini-transcribe, independently of chat; selected live voice behavior was not tested.

The local pricing table contains Luna input/cached/output values 0.1/0.01/0.5 USD per million tokens. This is source configuration, not a verified current tariff or a hard run budget. No paid model trial was run. Before a paid comparison, pin verified provider tariffs, a dollar ceiling, call/input/output limits and stop conditions. Hold fixtures and prompts constant while comparing context and reasoning separately. A stronger model is not selected based on scripted results.

## What changed and what is proved

The offline replay scorer previously passed a required correct artifact write even when the same trace included an unwanted older-file write of the same effect kind. A RED test reproduced that false pass. Evaluator-owned forbidden effect payloads now identify specific protected artifacts; applied and unknown unwanted writes fail, rejected attempts remain distinct. The existing effect-kind rules remain intact. This is an evaluation repair, not a live referent fix.

Six fictional cases carry separate visible context and grader expectations: identical basenames in different directories, similar names, different names, explicit older-file override, ambiguous follow-up and multiple current artifacts. Exact identities/revisions and known synthetic receipt text are scored; unwanted writes are rejected even alongside a correct write. The synthetic expected text is a known replay payload, not a requirement that every legitimate model-generated warmer draft match that wording. Real trials still need independent usefulness/content and final-state review. Replay explicitly leaves final_state unscored.

The actual local owner-DO fixture now covers four name/override variants across conversation loss and recreation, checks both host receipts, performs scoped reads/CAS revisions and verifies the other file is unchanged. The mock deliberately chooses the evaluator's target identity; it does not judge intent. Stale episode context is provided in the synthetic case bank, not proven through the live failing provider prompt. Neither scripted transport tests nor replay scores establish model uplift.

Focused tests: 26 passed across three files. Runtime worker and integration types: passed. No paid/live model comparison, no live referent rerun, no source guard/full release claim at this checkpoint.

## Live gap and next decision

Producer SK5 evidence reports the follow-up selected older SK4 after get_context and four episode searches while newly created SK5 stayed unchanged. The final provider instructions for that failing trace have not been inspected here. Rank open alternatives: receipt missing/withheld, receipt present but weak task/chronology evidence, or model reasoning error despite adequate evidence. Filename resemblance alone is unproved. Inspect the exact prompt and tool-result context before changing the serving context mechanism or model. Preserve explicit older-file overrides, ambiguity clarification, owner/run/CAS gates and current-request authority. No automatic newest-file or filename selector is added.

## Remaining release map

| Work | Current checkpoint | Remaining gate |
| --- | --- | --- |
| SK5 referent | Evaluation false pass repaired; synthetic matrix and owner transport checks passed | Exact failing prompt, real isolated context/reasoning comparison within known cost scope, reviewed runtime repair if demonstrated, live readback |
| Selective forgetting | Reviewed external packet received for integration next | Verify bundle, apply separate real DO wiring, canonical registered-path tests, shared release wall/reviews and scoped live acceptance |
| Browser continuity | Reviewed host packet queued; activation off | Current-owner host wiring and persistence/approval tests; actual account/budget decision before provider activation |
| New console | Cloud owner controls and SK5 download hash verified by root | Full signup and two-owner acceptance assigned to Instinct |
