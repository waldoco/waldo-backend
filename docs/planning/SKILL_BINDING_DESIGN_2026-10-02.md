# Skill binding into the Telegram owner path: design (draft, no DO edits)

Status: DESIGN ONLY. SOURCE reading; nothing run, nothing seeded, no flag flipped.

## What exists
- Loader and composer: `skills/loader.ts`, `skills/budget.ts`, `context-composer/skills.ts` (builds `systemSkills` candidates).
- A private seam: `owner-turn.ts` accepts `privateSystemSkills?: LocalSystemSkillBinding` and passes it to `resolveRunLoopAdapters({ WALDO_ENV: 'local' }, { localSystemSkills })`. `LocalSystemSkillBinding` is `{ principal_ref, tenant_ref, repository, budget }`.
- The production Telegram path never passes a binding, and the adapter environment there is hard-coded `'local'`. Only `test/owner-skills-private.test.ts` constructs one. So no skill reaches a live turn today.
- No skill content is in the repo; PR #525 describes a generator outside it. This change adds the five blocked skills as inert docs only (docs/skills/blocked-v1).

## Constraints from the identity work (#520, design)
`principal_ref` and `tenant_ref` must not be invented from `doName` or `subject`. Option (b), chosen by the main agent under decide-and-log (not by the owner), uses `do_name` as the principal key behind an exact-name, fail-closed staging allowlist. Production needs option (a).

## Proposed binding, in order, each its own reviewed PR
1. Repository: a `SystemSkillRepository` backed by a reviewed, digest-pinned bundle of skill texts (the loader already carries content digest and canonicalization per #520). Source of the bytes is a committed file, not a runtime fetch. Unknown: the repository interface details; not traced here.
2. Admission: the binding is constructed only when (a) WALDO_ENV is staging, (b) the DO name is on the allowlist, (c) a config flag is on. Any miss means no binding, same as today. Disable-first: turning the flag off removes skills from the next turn with no migration.
3. Principal: `principal_ref` derived from the authenticated directory row's `do_name` under a fixed namespace; `tenant_ref` an explicit staging constant. Never from message content.
4. Manifest check (main's decision under decide-and-log, not owner-approved): a skill is admitted only if every tool it requires is in the trigger's ACL and every connector it names is connected; otherwise it is excluded with a recorded reason. A skill can never widen the ACL.
5. Trial: read-only trial on staging for one skill first (a skill whose tools exist), watching the composer trace for the skill section. A skill is not called usable before that.
6. Order of skills: the five blocked ones stay inert until their tool exists; the unblocked skills in the pack are the first candidates.

## Seams and owners
The call site is `telegram-owner-do.ts` and the `'local'` environment in `owner-turn.ts`; both are Codex-owned seams. This document asks for nothing there yet; step 2 is the future seam ask.

## Decisions needed
- Owner: whether skills go live on staging at all, and the first skill.
- Reviewer: whether the repository should read committed bytes (proposed) or the external generator output.
