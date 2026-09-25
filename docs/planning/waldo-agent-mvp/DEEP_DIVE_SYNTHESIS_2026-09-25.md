# Deep-Dive Synthesis (2026-09-25)

Owner challenge (12:49 iMessage): prove the day's research was done properly - re-examine
every finding (Cloudflare audit, archive audit, Muse benchmark, capability matrix, memory
stack, redaction) through multiple lenses: software engineering, backend, agent-building,
harness engineering, context engineering, security, the user's perspective, different ICPs,
and every surface. Update docs where the deeper pass changes a verdict; then a build-plan
gap analysis. This doc is that pass.

Inputs re-read for this pass: CLOUDFLARE_ADAPTATION_AUDIT, WALDO_BRAIN_ARCHIVE_AUDIT
(+ correction below), WALDO_VS_META_MUSE_BENCHMARK, CAPABILITY_MATRIX,
SPOTS_CONSTELLATIONS_AND_DERIVATIONS, HARNESS_COMPARISON, plus live code verification.

## 0. What the deeper pass changed (verdict updates)

1. **Archive audit adopt #1 corrected.** Nightly consolidation IS live ('dreaming' schedule,
   telegram-owner-do.ts:712: consolidate 24h of episodes, promote constellations, arm day
   cards). Missed because the code says 'dreaming/nightly' where the archive says
   'compaction'. Residue adopted instead: episode consolidated-marking, a weekly deeper pass,
   diary rows as artifacts. The capability matrix was right; my audit was wrong; the
   correction is committed in the archive audit doc itself.
2. **Email ingress hygiene promoted.** In the Muse benchmark it was one of four trail items.
   Cross-lens it is the single highest-leverage security gap: OTPs/password resets/magic
   links are the lethal-trifecta fuel (private data + untrusted content + exfil channel), and
   alpha testers connecting real inboxes makes it user-facing, not theoretical. New slice E1
   proposed in the gap analysis below.
3. **Injection eval suite promoted.** Same promotion logic: we have canary tokens and
   adversarial-test discipline per bug, but no standing pack. Muse runs continuous agentic
   red teaming; we can wire canaries into a recurring scenario pack cheaply. New slice E2.
4. **Approval grant taxonomy adopted.** Muse's one-time/session/task/time-bounded/perpetual
   grants are the right shape for A7 standing orders: a standing order IS a perpetual,
   scope-bound grant. A7 gains the grant-types field.

## 1. Software engineering lens

Strengths verified today: contracts-first with pinned ripples (43 tools typed before wired,
dispatch fails closed - today's integration audit proved the prompt now says so honestly);
additive-only contract evolution (the 'rejected' code landed without breaking 1657 contract
tests); every fix carries a reproduction test (bug-log rule).
Weak spots the lens exposes: (a) the prompt-ceiling lie survived weeks because no test
asserted prompt text matches dispatch reality - a CLASS of drift, not one bug. Guard
candidate: a test that diffs prompt tool-text against formatToolDefinitions output per
trigger. (b) Docs drift (nightly consolidation marked "missing" in one doc, "live" in
another) - docs carry no verification; the archive audit correction is the instance.

## 2. Backend lens

Per-owner DO + Supabase split holds up: strong tenant isolation by construction, zero idle
cost, sqlite at the edge. Risks: (a) DO SQLite is single-writer - fine for one owner, but
A5 background tasks + A8 webhooks increase concurrent write pressure on the same DO; the
serial() wrapper already serializes turns, keep it load-bearing. (b) The archive's drift
warning applies to Supabase-side aggregates (CRS etc.) vs DO-side memory: two stores, one
truth - the derivation spine (SPOTS doc) is the answer, keep derivations recomputed not
copied. (c) pgTAP runs only on the Mac - CI would catch migration/fixture drift without
him; noted, post-alpha (guard-migration-fixture-sync covers the static side).

## 3. Agent-building lens

The field consensus (OpenClaw, Hermes, Muse, the archive) converges on: typed memory +
workspace + approvals + channels + background work. Waldo's alpha set now covers all five
after today's fold-ins. Where Waldo is genuinely ahead: trust classes carried through
recall (nobody else), payload-bound approvals (Muse's are scope-bound, ours are
bytes-bound), the L1 scenario harness with pinned gates (nobody else). Where behind:
subagents/swarms (Muse, Instinct), self-authored tools (Muse), real computer (Muse).
Judgment: swarms and self-written code are correctly post-alpha for a trust-first product -
they multiply the attack surface before the approval rail has mileage.

## 4. Harness-engineering lens

Today's three fixes share one root: the harness is only as honest as its surfaces. The OTLP
root span lacked trace-level IO (observability surface lying by omission), the prompt listed
ceiling tools (instruction surface lying by commission), MCP errors mislabeled (feedback
surface lying by classification). Generalized rule worth pinning: EVERY model- or
user-facing surface gets a fixture that asserts it against the underlying mechanism. The
guards dir is where that lives; candidate guards listed in the gap analysis.

## 5. Context-engineering lens

Current stack: 7-layer REASONS canvas, trust-filtered hall recall, FTS5 episodes, tool-output
offload (flag-gated), progressive compaction. Gaps by this lens: (a) recall ranking is
trust-only - decay (archive adopt #2) and vector similarity (V1) are both ranking inputs;
design them as ONE ranker with typed factors, not two bolt-ons. (b) WALDO_TOOL_OFFLOAD is
off on staging with read_tool_output unregistered - the offload path is untested in anger;
either wire it in packet v4 with a live check or stop carrying the flag. (c) Prompt budget:
no per-layer byte budget test exists; the FailClosed on empty mandatory layers exists but
nothing bounds total size - add a size assertion to the prompt-builder snapshot tests.

## 6. Security lens (Muse cross-read)

On par: custody hard line, fail-closed dispatch, payload-bound approvals, taint classes,
egress guard. Exceed: no training on owner data, no card custody, portable memory. Trail:
email hygiene (E1), kernel-depth isolation (accepted for alpha), browser guardrails (adopt
with browser deepening), standing injection evals (E2). New from this lens: Muse's email
filter list (OTP/reset/magic-link) is a deterministic pattern set - E1 is a regex-class
filter + classifier, no new infra, and it also belongs on the WHATSAPP ingress path (links
people send the agent) not just gmail.

## 7. User-perspective lens (ICPs)

- Founder-operator (the owner himself): wants the agent to DO things (email, calendar,
  shopping, meals) with proof it won't leak or misfire. Today's work serves him directly:
  send rail, whatsapp, traces he can debug.
- Developer ICP: wants MCP + console + traces. A4/O1 serve them; the console trust surface
  ("Your Waldo") is their differentiator demo.
- Health-tracker ICP (archive's original): CRS/meals/workouts; A9 + followups register
  (adopt #3) are their core loop; the followups register is what makes nudges feel learned
  rather than random.
- Non-technical consumer (Muse's target): needs approvals that read plainly and undo that
  works; our desk cards + 10-min undo match; our ledger UI in the console trust surface is
  the proof artifact.
Cross-ICP finding: every ICP's trust story ends at the same artifact - the ledger. It is
already the most honest surface we have; the console trust surface should lead with it.

## 8. Surface-by-surface

- WhatsApp: code-complete, awaiting Meta verification + packet v3 deploy. Buttons flatten to
  reply-lines (W3) - verify that reads naturally in real chats during his end-to-end test.
- Telegram: live; O1 trace previews need the packet's LANGFUSE_CAPTURE_TEXT to show value.
- Console: sign-in awaits packet v3 step 6 (A3 proof); trust surface specced in the Muse doc.
- Email: read+draft live, send rail tests-only until redeploy; E1 hygiene gap noted.
- iMessage: not a Waldo surface (correctly - no official API; the archive's channel list
  predates that call).
- Future app: the artifact library + trust surface are its two anchor views; both specced.

## 9. Build-plan gap analysis (what's missing after this pass)

Proposed additions (following his fold-in directive; costs honest):
- E1 - Communication ingress hygiene filter (OTP/reset/magic-link, deterministic + classifier)
  on gmail read + whatsapp link ingress. Half a slice. BEFORE alpha testers. 
- E2 - Injection canary scenario pack: existing canary tokens wired into a recurring
  adversarial scenario suite. Half a slice. Can run in CI later.
- A5 gains: consolidated-marking + weekly deeper pass (corrected adopt #1) + diary rows as
  first artifacts. Already folded.
- V1 gains: decay factor in the same ranker as vector similarity (one ranker, typed factors).
- A7 gains: Muse grant taxonomy (one-time/session/task/time-bounded/perpetual) as the
  standing-order grant type.
- Prompt-layer size budget test (context lens c). Trivial.
- Guard: prompt tool-text vs formatToolDefinitions diff per trigger (SWE lens a). Trivial.
- Deferred with reasons: dps full-timeline review (needs logged-in browser; marketing value,
  not engineering), OpenMausBot look (same bucket), WALDO_TOOL_OFFLOAD live decision (packet v4).

## Compared against

Every claim above cites a doc committed today or code verified live this run; external
sources (Muse post, dps post, archive) were fetched, not recalled. The one correction
(compaction) is documented in place rather than silently edited.
