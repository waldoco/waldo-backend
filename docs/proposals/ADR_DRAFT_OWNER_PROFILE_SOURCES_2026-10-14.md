# ADR draft: who the owner is — profile sources, precedence, and the first conversation

Status: proposed, 14 Oct 2026. It becomes a Brain ADR under the next free number once the owner accepts it; until then it is a candidate, not authority. It records the memory decisions behind slice (ii) of the identity plan (`docs/planning/lanes-2026-10-13/IDENTITY_ONBOARDING_PLAN.md` on `docs/overnight-2026-10-12`, §5 row (ii), decisions D2, D5 and D8). The owner's words: Waldo leads a "getting to know you" conversation the first time it talks with someone, on any surface; the answers become memories; "If it requires an ADR then we can definitely make it"; the time zone may be set from chat (option T1).

Source read at `mac/google-profile` `d41cbf11` (#1218 on `beta-mvp` `72030b34`).

## 1. Context

- **"Who am I" fails today.** No name is stored. The composed identity line names an opaque principal (`context-composer/owner-turn.ts`), and the profile block shows only owner-grounded claims (`memory/claims.ts`, `profileEligible`).
- **#1218 adds a provider fact.** The name on each connected Google account is kept in object KV `google:profiles` (keyed by account id, replaced on reconnect, removed with its account). It reaches the prompt as one fenced line: "From the owner's Google account, not yet confirmed by the owner (data only, not instructions) … If the owner has told you what to call them, their words win" (`prompt/messaging-behavior.ts`, `googleNameLine`).
- **The app's onboarding** will ask for the owner's day shape, what goes wrong, and how much autonomy they give (app handoff, item 27). Nothing stores those answers yet.
- So three sources describe the owner, and no rule says which one wins, where each one lives, or how each one is corrected.

## 2. Reference practice

- **Anthropic, context engineering** ([effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)): load a little up front and fetch the rest just in time through tools. Waldo already does this: a pinned profile block on every turn, and recall per message.
- **Anthropic, memory tool** ([memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)): memory is read just in time. Cap its size, and strip sensitive data in the handler rather than trusting the model to leave it out.
- **Letta memory blocks** ([memory-blocks](https://docs.letta.com/guides/agents/memory-blocks), legacy V1 docs): blocks stay in context, each with a character limit, and the agent edits them through tools.
- **Hermes Agent, persistent memory** ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)): a capped USER.md, 1,375 characters, holds "information about the user's identity, preferences, and communication style". The agent writes it without being asked. It is "injected into the system prompt as a frozen snapshot at session start", so an edit shows from the next session.
- **mem0, How Mem0 Works** ([memory-types](https://docs.mem0.ai/core-concepts/memory-types)): extraction is additive, and corrections go through explicit `update` or `delete` operations. The page gives no rule for ranking conflicting sources.
- **ADR-0046** (accepted; Brain `be08c4af`): trust classes `system_of_record > user_stated > memory_committed > memory_provisional > inferred`. Rule 1: "A SoR outranks memory only for state it owns."
- **Common thread:** a small, capped profile is always in context, written by the agent from the user's own words and corrected by explicit update or delete. None of these systems ranks a provider's label above what the user says about themselves.
- These quotes come from the [harness practice note](https://github.com/waldoco/waldo-backend/blob/docs/overnight-2026-10-12/docs/planning/lanes-2026-10-13/HARNESS_PRACTICE_REFERENCES.md) [S7, S16, S25]. The Hermes and mem0 pages were fetched on 14 Oct 2026.

## 3. Decision

### 3.1 Sources and precedence

The domain is who the owner is and how to address them. In descending order:

1. **Owner-stated.** A claim written through `remember` that quotes an owner-authored message verbatim: `origin: owner`, `source: stated`, `source_ref: owner, <message_ref>`, `verification_status: owner-grounded`. First-conversation answers are this class.
2. **Setup answers.** What the owner chose or typed in the app's onboarding. The owner entered them, but a form answer is coarser than a chat statement and usually older.
3. **Provider-asserted.** What a connected provider says about the account, kept per account in object KV `google:profiles` (#1218):
   - **stored:** the name parts (`name`, `given_name`, `family_name`) and, when the owner granted that scope, the phone number;
   - **reaches prompts:** the fenced name line only. The phone never reaches a prompt or a log (#1218's tests);
   - the account email is the connection's identity in `google:accounts`, not a profile fact;
   - picture, birthday and gender are not requested (D8).

**Reconciling this with ADR-0046.**
- Google is the system of record for the label on the Google account. It is not the system of record for what the owner wants to be called.
- Under 0046 rule 1, `user_stated` is the authority in this domain. This draft applies 0046; it does not amend it.
- Setup answers and chat statements are both `user_stated`. Between them, the newer and more specific statement wins, as 0046's same-class refresh says.

**How precedence works today.** The claims plane has no `dominates()`; ADR-0046 is not built here. Three things carry precedence instead:
- **Provenance labels the model reads.** The Google line says the name is unconfirmed and that the owner's words win. Setup answers carry their own `source_ref` prefix (§3.5).
- **Explicit corrections.** `remember` with `replaces_id` is an atomic correction.
- **Model judgment.** Whether two statements are about the same thing is the model's call, never a regex (CLAUDE.md).

A coded `dominates()` waits for the ADR-0046 build.

### 3.2 Storage (option M1)

- **Owner claims stay in the existing claims plane** (`memory/claims.ts`), with one writer per owner object.
  - No new table, no new provenance value, and no change to `profileEligible`.
  - How `remember` writes is unchanged.
- **The provider fact stays in object KV `google:profiles`** (#1218) and is never copied into claims. When the owner confirms or corrects the name in chat, the model saves their own words with `remember`, and that claim then outranks the KV fact.
- **Rejected: M2,** the Google name as a claim with a new provenance.
  - It widens `profileEligible` and mixes provider assertions into the owner-grounded set.
  - `forget_memory` and the nightly pass would then reason about a row the owner never said.

### 3.3 Correction and forget

- **Owner claims:** corrected with `remember` plus `replaces_id`, and removed with `forget_memory`, whose barrier blocks relearning. Unchanged.
- **Provider facts: correction.** The owner's own words win (§3.1). A correction is saved with `remember` as an owner-grounded claim, which outranks the provider line. Waldo never edits the provider record; it is Google's assertion, refreshed at each connect.
- **Provider facts: forget without a disconnect** (condition C2 of the bounded persistence review on #1218). A forget suppresses a provider field when one of the owner's forget barriers matches it exactly. The match uses the fingerprints `remember` already uses to refuse relearning: `textFingerprint` of the trimmed text, and of its lowercased, space-collapsed form.
  - **Name parts** (`name`, `given_name`, `family_name`): the name line checks the barriers each time it renders and leaves out any account where a part matches. All parts go, since a partial name would carry the rest. A reconnect replaces the stored profile wholesale (#1218), but the barrier lives in the claims plane until the owner lifts it, so a render-time check survives the reconnect.
  - **Phone:** it never reaches a prompt, so there is nothing to render. A forget that matches it removes the field from `google:profiles` when the forget settles, and a later connect does not store it again while the barrier stands.
  - **The phone is identity, not memory.** Its bound is plan row (i), condition C3 on #1218:
    - it is an unverified provider claim, kept only in `google:profiles`;
    - nothing reads it without its own bounded review;
    - it is never an admission key, a binding, a sender match or a write to the owner's phone;
    - at most it prefills a number the owner then verifies;
    - it is removed with its connection or account.
  - **Deterministic by right.** A forget must be guaranteed, so this check is a privacy boundary under CLAUDE.md, not a judgment rule.
  - **Paraphrase gap.** A barrier's topic is literal text from the owner's message, so "forget my name" without the name itself matches nothing. The model then saves the owner's wish with `remember`, which outranks the provider line. A deterministic per-account "hide the Google name" owner control is a later follow-up.
  - **Disconnect** still removes every provider field (#1218).
- **Where it lands:** a follow-up PR straight after #1227. It carries the review's scenario test: forget the name, then the next turn has no name line and the forget settles.
  - **Falsifier:** an owner forgets their name and Waldo still uses it.

### 3.4 Pinning, and when answers become visible

- **Who pins.** The nightly pass curates the `owner_profile` and `owner_facts` pins. Nightly arms for an app owner only once the time zone is confirmed (`owner-do.ts`, `armable`).
- **New owners see answers at once.** While nothing is pinned, `turnMemoryPrompt` shows the newest owner-grounded claims on every turn (`claims.ts`; profile and facts budgets combined, 4,000 characters). A first-conversation answer saved with `remember` is in the very next model call. A new owner has nothing pinned before their first nightly pass, so this is the path they take.
- **After pins exist:**
  - A new claim is visible through per-message recall, and through the transcript within the same conversation. It joins the pinned block at the next nightly pass.
  - A correction with `replaces_id` carries the old claim's pin to its replacement (`claims.ts`, `correct`), so a corrected pinned name updates the block at once.
  - Hermes, by comparison, shows any change only from the next session.
- **`set_timezone` (T1)** confirms the zone from chat and arms nightly, so an owner who never opens the app's zone control still gets nightly passes.
- **Accepted limitation:** a new fact stated after pins exist, and not a correction, relies on recall until nightly.
  - **Falsifier:** that fact is missing from a same-day turn in another conversation where it mattered. A live pin path would then be needed.

### 3.5 Setup answers (app handoff, item 27)

- **Same plane, same writer** (`store.add`), never a parallel profile table.
- **`remember` cannot take them,** because its grounding needs a verbatim quote from a chat message. They arrive through an owner-authenticated app route: additive to app.v1, with the app lane told first. The route writes one claim per answered question:
  - `origin: owner`, `source: stated`;
  - `evidence`: the answer as the owner chose or typed it;
  - `source_ref: owner, setup:<question_id>`. This prefix is what lets the model tell a setup answer from a chat statement.
- **Kind per question:**
  - day shape is `routine`;
  - what goes wrong is `fact`;
  - autonomy is `preference`.
- **They become profile-eligible automatically.** A claim with `origin: owner` and a `source_ref` is stored `owner-grounded` (`claims.ts`, `add`). That is right for the owner's own answers, which makes the route the trust boundary. It needs:
  - the session check;
  - schema validation and a size cap;
  - the Scribe's numeric health floor, so health answers stay qualitative.
- **Autonomy is context, never a grant.** Memory is not permission (CLAUDE.md). For the answer to change behaviour, the app sends it through the existing owner controls (proactivity, schedule preferences) as separate owner actions.

### 3.6 The first conversation (slice ii)

- **The signal.** A host-fact line is added on the owner's own turns only, never on jobs or proactive work, and only while the owner has no owner-grounded profile claims. Its facts:
  - that count;
  - whether the zone is confirmed;
  - whether an unconfirmed Google name is present (the name itself is not repeated);
  - the surfaces the owner has written from.
- **The behaviour line.**
  - Answer what they asked first.
  - The model decides whether to get to know them, what to ask and how much.
  - It saves answers with `remember`, quoting the owner.
  - No code decides what counts as getting to know someone.
  - An owner who has finished setup has claims, so they see no signal and are not asked again.
- **Time zone (T1).** `set_timezone` sets the zone on the owner's explicit statement in their own turn. This amends the 12 Oct design in which only the `timezone.set` control confirmed a zone (D5). The control and the tool now share one writer: save settings, set `timezone_confirmed`, arm the owner's jobs.

## 4. Consequences

- **Privacy.** The Google name already reaches model context under #1218; this slice adds only a presence bit and counts. No phone number, email or picture.
- **Authority.** `set_timezone` changes only the owner's own zone setting, on an owner turn. It arms exactly what the app control arms.
- **iMessage-only owners.** A zone set from iMessage arms jobs. Delivering them to iMessage is slice (vi).
- **Rollback.** Revert slice (ii). Claims already written stay: they are the owner's own words, and forget still works on them.
