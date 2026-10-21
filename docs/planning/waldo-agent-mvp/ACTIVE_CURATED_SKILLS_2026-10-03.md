# Active curated skills: first usable slice

## Why build this

Serving base `c1f700b4ed4f41f3658885a60f2f31dcfcce0015` had an existing validated runtime loader and SQLite skill row contract, but the ordinary owner host supplied no active procedures. Workspace `SKILL.md` files are external data and must not become authority. The owner needs one reusable preparation workflow with version selection, later-turn continuity and a real off switch.

Decision: adapt progressive disclosure to one reviewed, code-owned instruction-only procedure, `document-email-preparation@1`. Reuse the existing `RuntimeSkillLoader`, serializer, skill row/table and owner safeguards. Do not add downloads, marketplace trust, arbitrary scripts, new connectors or workflow tool grants. Eager trigger loading would expose irrelevant instructions on every user message; returning bodies through a skill tool would retain them in history after disable. Both alternatives were rejected.

Primary references inspected 3 October 2026:
- OpenAI skill authoring: https://learn.chatgpt.com/docs/build-skills
- Anthropic skill architecture/security: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- OpenAI byte-level BPE reference: https://github.com/openai/tiktoken

No upstream code was copied. The byte budget uses the conservative UTF-8 byte length of the complete rendered fragment and block, justified for byte-level BPE and explicitly labeled an upper-bound estimate. It is not an exact tokenizer count or a fixture `tokens:1` adapter. The existing per-skill cap remains 600; unavailable/oversize adapters suppress instructions. No model/tokenizer performance parity is claimed.

## Owner path

Initial developer/test lifecycle commands:
- `/skills install document-email-preparation@1`
- `/skills disable document-email-preparation@1`

These commands are only needed for lifecycle changes. Once enabled, ordinary preparation/revision tasks let the model select `skills_load` from metadata. The body enters ephemeral trusted context under owner safeguards, never a tool result or conversation history. Every step and every physical provider retry rechecks current storage, owner/run authority and procedure identity. New turns need a fresh selection; installation persists in the existing skills table. Disable suppresses later instruction loading, including retries/medical recursion already in progress.

This is not polished consumer onboarding. Natural-chat/console approval UI is a follow-up; it must carry explicit owner lifecycle authority and reuse this capability rather than infer installation from an unrelated task. Background installation, arbitrary skill uploads, remote catalogs and generated/self-authored procedures are outside the slice.

## Trust and integration

Canonical owner-message composition keeps its original zero-skill repository/skill-prompt guards. An explicit typed host capability supplies only this catalog procedure; its four strict skill-control handlers remain intersected with the canonical host's existing grants.

The currently serving legacy Telegram owner route is supported through a small private authority bridge. Existing owner listener/ingress authenticates sender and private chat. The bridge additionally pins the active inbox update, run/attempt, resolved Telegram subject, DO name and conversation trace, and rechecks them before/after use. It cannot prepare lifecycle authority for background or media/probe turns. Hook snapshots clone the scope object, so the handler verifies the captured opaque admit/commit closures plus run identity, not object equality. Mutations execute through the captured original scope.commit.

Stored activation pins catalog version, reviewed source, custody identity and all instruction/loader fields. The legacy custody key uses the actual verified Telegram subject rather than its shared fixture context principal. Another owner cannot inherit or overwrite activation. Forged source, body, arrays, tools, or contradictory archive/curation fields do not load. Missing legacy table initialization reuses the exact existing migration DDL through `SKILLS_TABLE_SCHEMA`; there is no new table shape, migration version or cloud database change.

The closed tool registry, strict schemas, hook registry, trigger ACL, privileged lifecycle/taint classification and final prompt ceilings all include the new tools. Lifecycle controls are user-message-only. Installation adds no workspace, messaging, external reach or execution capabilities. The LLM request capacity derives from the closed registry, capped at the existing provider ceiling, so a growing registered ACL remains representable without changing permissions.

## Acceptance evidence

Deterministic fake-provider proof uses the actual default TelegramOwnerDO, actual owner inbox/run scope, real dispatcher/hooks/loader and workspace store/tools. Synthetic provider and workspace-host bindings deny real network:
1. Explicitly install once; persisted reviewed row is active
2. A later normal task selects the procedure, prepares and saves an email draft at revision 1
3. Reconstruct the DO, then a new turn selects the procedure, reads the saved file and writes the same file at revision 2 with the changed time
4. Read back the revised text, then disable; later model requests omit the body
5. Assert instruction bodies never appear in model input/tool history and the offered workflow tool set never expands

Boundary regressions cover unknown versions and uploaded names, foreign owner/custody, forged scope/functions/update identity, tainted lifecycle arguments, closed runs, catalog immutability, forged source/body, contradictory storage, unavailable/oversize budget, disable during loader awaits, physical reduced-context retry and medical recursion.

Independent review found and causally proved two defects during development: hook-cloned scope identity rejected valid lifecycle tools, and a captured procedure survived reduced-context/medical retries after disable. Both were fixed and have real-dispatcher/real-provider-boundary regression tests. Final independent source review found no remaining blocker.

Local verification (final code, matching dependency cache and unchanged lock SHA `a4aad7cd754a383bf6b90ee8864689b9855541837036d868f6decb7fac777843`):
- Runtime full suite: 239 files, 3,056 tests PASS
- Contracts full suite: 92 files, 1,748 tests PASS
- Isolated owner-ingress suite: 3 files, 57 tests PASS
- Final focused skill/canonical/context/prompt suite: 8 files, 79 tests PASS
- Runtime worker/integration and contracts TypeScript checks: PASS
- Dashboard source build and asset worker tests: PASS; generated assets are local, untracked build prerequisites
- `git diff --check`: PASS

First full runtime execution had two intentional final-prompt digest/snapshot changes and one missing-build asset failure. The final prompt pins were re-derived for the four new ACL names; the missing local dashboard assets were built from unchanged source. A fresh entire runtime suite then passed. This is not a skipped or relabeled older result.

Full top-level CI/live Supabase checks are not claimed here. Static guards require a committed strict-ancestor migration base; their final result is recorded in the handoff. Dependency installation initially lacked an offline tarball; the existing independently copied cache was checked against the unchanged exact lock, including Wrangler 4.135.0 and Vitest 4.1.9. Actual-model and live-provider/deployed acceptance are NOT RUN. No source was published or deployed, no external account was created, and no credentials or persistent grants were added.

## Current-serving integration

Integrated onto `4485c64492854b42db2a4e552dc5fe1f598c3758`. The original source packet remains pinned to `8e5c45f64c5af2f979d692f64e5f16b36bdf49ca` over c1f; its full-runtime evidence belongs to that candidate, not a relabeled current-base full suite.

Mail envelope, background tool intersections, source_ref requirement and default-off collection were preserved. Latest strict reply-effect mapping now includes list=null, install=skill_enabled, disable=skill_disabled and load=skill_selected; selection does not promise instruction admission or new capabilities. Existing skills retention classification remains KNOWN_GAP with no new exemption or table.

Storage materialization is bounded before JavaScript through SQL type/UTF-8 BLOB-length CASE projection. Rejected existing rows retain their presence, so installation cannot mistake them for absent rows and reactivate them via ON CONFLICT. Actual-SQL oversized and NUL-tail tests first observed raw body materialization, then passed with bounded projection. The projection includes every required text field, including provenance; happy-path regressions caught and resolved the initial omitted column.

Current-base receipts:
- Initial integrated skill/canonical/composer/effect/store checks: 11 files, 103 tests PASS
- Mail/background integration: 3 files, 23 tests PASS
- Final bounded-guard + skill + effect + store + mail tests: 9 files, 44 tests PASS
- Full contracts: 92 files, 1,748 tests PASS
- Worker/integration/contracts TypeScript: PASS
- Independent integration review: no blocker; final bounded guard separately reviewed

No complete current-base runtime/required CI/live acceptance is claimed. Root owns those release checks. There was no new activation, external grant, publication or deployment during integration.
