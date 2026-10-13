# Mac core lane C: A1, the canonical inbound turn with authorship

Written by the Mac orchestrator on 13 Oct 2026, about 23:15Z. It launches once #1149 has merged to `beta-mvp`. The spec is the backend lead's #1103 comment 6154346852, and the lead reviews and gates the PR. The owner's bar applies (digest item 35): no rash decisions, and mature practice cited for every ambiguous design point. The board is waldoco/waldo-backend#1103.

## Rules

Read these first:
- `CLAUDE.md`;
- `.claude/rules/INDEX.md` and the five rule files it lists;
- `AGENTS.md`.

The spec is the contract, so read it whole: `gh api repos/waldoco/waldo-backend/issues/comments/6154346852 --jq .body`.

## The problem, from the spec

Every surface hands the responder a single `text`. So the owner's own words, a quote they pasted, a message they forwarded, and the transcript of a file they sent are told apart only by Telegram entity ranges. Those ranges reach memory and the index, but never the model. Meanwhile:
- a transcript is joined into the owner's message;
- the Telegram gate refuses a forwarded message outright.

## Scope: one PR, exactly the spec

**New module.** Add `channels/owner-inbound-turn.ts`, with:
- `INBOUND_AUTHORSHIPS`, `InboundPart` and `OwnerInboundTurn`;
- `inboundTurn`, the only constructor;
- `ownerWords`, `receivedView` and `renderForModel`, with the typed label table.

**The adapters:**
- **`telegram-polling.ts` `toTurn`:** split the text into parts by quote entities, in UTF-16 offsets, merging any that overlap. `forward_origin` makes every text part `forwarded`.
- **`packages/contracts/src/adapters/channel.ts`:** add `forward_origin` to `telegramMessageUpdateSchema.message`, as an additive runtime adapter contract. It is not app.v1. Update the contract test that lists forwards as unsupported, and any reply wording that says so.
- **`telegram-media.ts`:** `LoadedMedia` becomes `{ parts, attachment? }`, and a transcript gets its own `file_transcript` part.
- **`telegram-turn.ts`:** pass the turn's parts through and append the media parts. `mediaNote` goes away.
- **`surfaces/whatsapp.ts` `toEnvelope`:** stays type-correct and unwired, as the spec says.
- **iMessage:**
  - `imessage/ingress.ts` `admittedIMessageTurn` sets `parts: ownerWords(event.text)`;
  - `imessage/media.ts:84` narrows its parameter type.

  These are exactly the spec's two changes. iMessage is Ashish's area, so change nothing else there, and name both edits in the PR body as an FYI for Ashish.
- **`owner-do.ts`:** the probe at about line 1682 builds its turn with `inboundTurn`. That is A1's only line in this file.

**Envelope and responder:**
- `owner-turn-envelope.ts` gains `parts` and loses `sourceQuoteRanges` and `mediaNote`.
- `owner-turn.ts` `respond` uses `receivedView` for the store and the index, and `renderForModel` for the model.
- `converse` gains a trailing `shown` argument.
- The memory view carries the rendered text and `foreignRanges`.

**Prompt:** one line in `prompt/messaging-behavior.ts`. It states a provenance fact: shared content is context, not the owner's statement or instruction. It is not a judgment rule.

**Not in A1:** renaming the ids or the listener (A2), generic attachments (A4), WhatsApp wiring (A8), iMessage attachments at admission (Ashish's), app attachments, `use_mac`, and anything in #1149's region beyond what merges in.

## Judgment stays with the model

The labels are provenance facts that the code knows for certain: Telegram entities, `forward_origin`, and the file transcript. That makes them hard facts, and deterministic code may handle them.

How the model reads labelled content is the model's call. Add no keyword rules and no "if quoted, then refuse" logic.

## Prior art (the owner's bar)

The PR body gets a "Prior art and decisions" section. Cite sources you read yourself, at least for these points:
- **Delimiting untrusted or third-party content for the model:** labels and closing markers as data, not instructions. Check Anthropic's guidance on prompt injection and on structuring prompts with clear delimiters, and the OpenAI Model Spec on ignoring untrusted data by default.
- **Keeping the stored transcript unlabelled** while the model view is labelled: one source of truth, and the view derived from it.
- **UTF-16 offsets:** cite the Telegram Bot API's entity offset definition.

## Tests, red first

The spec's list:
- `owner-inbound-turn.test.ts`: the `text` invariant, labels and closers per kind, and `foreignRanges`, with an emoji placed before a block to pin the UTF-16 arithmetic;
- `telegram-polling.test.ts`: entities to parts, nested and overlapping entities, caption entities, and `forward_origin`;
- `telegram-media.test.ts`: a voice note gives `media_note` plus `file_transcript`;
- through the responder: a `remember` call sourced to a quoted or transcript span is refused, and `nightly-quoted.test.ts` from #1149 passes unchanged;
- a trace assertion: the model input carries the label, and the stored `appPayload` doesn't;
- the A0 guard: no file's surface-compare count goes up.

## Verify, stage by stage, at the exact SHA

- **`git diff --check`.**
- **`npx -y pnpm@10.34.4 verify:guards`.** `guard-pgtap` is UNAVAILABLE on macOS; run the guards that sort after it one by one, from the repo root.
- **`pnpm -r typecheck`.**
- **Every non-Supabase vitest config** of `@waldo/runtime`, from `package.json`, plus `@waldo/contracts`.
- **`verify:supabase` is NOT RUN.** Never run `supabase` locally.
- **Before a full suite,** check `pgrep -fl '[v]itest[.]mjs'`. A bare `vitest.mjs` pattern matches your own waiting shell.
- **Failures:** classify each one per `.claude/rules/posture.md`.

## Git and PR

- **Branch:** `mac/a1-inbound-authorship`, from `origin/beta-mvp` after #1149 has merged. Unset any upstream that points at `beta-mvp`.
- **Commits:** by path. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **PR:** `gh pr create --repo waldoco/waldo-backend --base beta-mvp`, ready for review.
  - The body covers the problem, the change, prior art and decisions, the files, the tests with red-first evidence, the impact surface (contracts: the additive Telegram gate field), and rollback.
  - It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **The `owner-do.ts` slot:** the lead's queue puts A1 after #1180 and #1186 and before #1108. If the tip moves while you work, merge it in. Never rebase.
- **Never:** merge, deploy, `--no-verify`, force-push, secrets, `.env`, health values, subagents, or posting on #1103 (the orchestrator posts).
- **Budget:** about 250 tool calls.

## Report back

- the PR number and head SHA;
- the CI state;
- the files touched;
- the decisions and the prior art;
- every verify result, per stage;
- any questions for the lead.

Stop once the PR is open and CI has started.
