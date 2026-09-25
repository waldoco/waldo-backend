# How production agents handle PII/secret redaction in tool-call pipelines

Date: 2026-09-25. Trigger: owner question after the draft_email redaction bug ("how do production
systems handle this - codex, yourself, other good agents like Hermes"). Every claim below is from
a primary source fetched today; URLs inline. "Hermes agent" verified as NousResearch hermes-agent
(open-source personal agent, github.com/NousResearch/hermes-agent).

## The headline

**Nobody serious redacts executable tool-call arguments.** The industry pattern is three distinct
boundaries, and redaction lives at only two of them:

1. **Execution path (tool args): gate, don't rewrite.** Secrets in args are *rejected*, not
   substituted. Control planes (permissions, approvals, sandboxes) decide whether a call runs;
   nothing rewrites what it says.
2. **Model boundary (prompt -> provider): placeholder + restore, or nothing.** If a system hides
   PII from the model provider, it keeps a vault mapping and restores placeholders before use.
3. **Display/log/trace boundary: redact freely.** Logs, traces, streamed UI text, env dumps -
   this is where redaction is universal and aggressive.

Our draft_email bug (scribe redacted `to: priya@example.com` -> `[REDACTED_EMAIL]` -> zod reject)
was a boundary error: we applied boundary-2/3 semantics to boundary 1.

## System by system

### OpenAI Codex CLI
- No pre-network DLP at all. An open feature request asks for exactly that: "local pre-submit
  DLP/redaction layer for secrets before prompts are sent upstream" - today a pasted secret goes
  straight into the request payload. github.com/openai/codex/issues/25585
- What Codex *does* redact: display and logs. PR #36893 redacts secrets from app-server command
  execution items; #5648 redacts env var values in `/mcp` output.
  github.com/openai/codex/pull/36893
- Execution safety comes from sandboxing + approval modes, not content rewriting.

### Claude Code
- PreToolUse/PostToolUse hooks are a control plane: allow/deny/modify via permissionDecision.
  No built-in PII redaction of tool args; users can wire their own hook. code.claude.com/docs/en/hooks
- Permissions system gates which tools run and when the human is asked.

### OpenAI Agents SDK
- Tool input guardrails *reject* secrets in args; the docs' canonical example:
  `reject_content("Remove secrets before calling this tool.")` - reject, never rewrite.
- Blocked tool *output* is replaced with a data-free placeholder ("Output withheld by an output
  guardrail.") for session replay - redaction for storage/replay, after execution.
  openai.github.io/openai-agents-python/guardrails/

### LangChain (PIIMiddleware)
- Strategies: redact / mask / hash / **block**. `block` raises - again, reject exists precisely
  because rewriting is wrong for some classes.
- Defaults tell the story: `apply_to_input=True` (redact user text before the model - provider
  privacy), `apply_to_output=False`, `apply_to_tool_results=False`. Optional stream transformers
  can redact streamed tool-call args for *display/state*, off by default.
  docs.langchain.com/oss/python/langchain/guardrails

### LLM Guard (ProtectAI) - the placeholder-and-restore reference
- `Anonymize` on input: PII -> `[REDACTED_PERSON_1]` style placeholders, originals in a `Vault`.
- `Deanonymize` on output: placeholders mapped back from the vault before use.
- The pattern that makes redaction-toward-the-model safe: **restore before semantics matter**.
  llm-guard.com/input_scanners/anonymize/, llm-guard.com/output_scanners/deanonymize/

### Hermes Agent (NousResearch)
- `agent/redact.py`: regex secret redaction explicitly scoped to "log files, verbose output, or
  gateway logs" - the observability boundary, not execution.
- Their false-positive lesson mirrors ours: sensitive key matching is exact-match, with the
  comment that `token_count` and `session_id` must NOT match - substring matching corrupts
  innocent payloads. github.com/NousResearch/hermes-agent/blob/master/agent/redact.py
- On by default (secure default), opt-out is logged loudly at startup.

## Takeaway for Waldo's scribe design

What we shipped this morning (5c12ae4) matches the industry shape:

- **Executable args and PostLLMCall tool_calls: checked, never rewritten.** Hard classes (canary,
  ADR-0081 health values, injection) still halt fail-closed - the OpenAI Agents SDK "reject,
  don't rewrite" posture.
- **Text to the owner and logs/traces keep full redaction** - the Hermes/Codex boundary.
- send_message keeps its pinned arg redaction for now (tool-dispatcher.test.ts:379); whether that
  pin is deliberate privacy or the same bug in a tool nobody uses from chat is an open design
  question, flagged not flipped.

Two standing notes:

1. **If we ever want provider-side PII hiding done right, the LLM Guard vault pattern is the only
   correct version**: placeholder at the model boundary, restore at execution. Without restore,
   redaction-toward-the-model corrupts semantics exactly like our bug. Our current pre-LLM request
   sanitisation redacts emails in the outgoing request (pinned in llm-provider.test.ts) with no
   restore mapping - whether the live model ever sees a raw owner-typed email address is an open
   live-verification item from the draft_email deploy check.
2. **Redaction false positives are a known industry trap** (Hermes's exact-match keys). Any future
   scribe pattern added to an executable path needs an adversarial test proving innocent args
   survive byte-identical - the harness hop assertions are the net for this.
