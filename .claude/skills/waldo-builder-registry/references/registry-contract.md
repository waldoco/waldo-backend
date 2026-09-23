# Registry Contract

This is the target shape for Waldo builder registry records. It can be represented as JSONL, YAML, a database row, or a future plugin manifest, but the fields should remain semantically stable.

## Record Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable slug, never reused after deletion. |
| `name` | yes | Skill name matching `SKILL.md` frontmatter. |
| `display_name` | yes | Human-readable name. |
| `version` | yes | Local registry version, separate from upstream tag. |
| `description` | yes | Trigger-oriented description. |
| `invocation_mode` | yes | `model`, `user`, `router`, `runtime`, or `manual-only`. |
| `trigger_types` | yes | User phrase, tool event, repo state, scheduled sweep, review gate, runtime signal. |
| `trigger_condition` | yes | Concrete condition for activation. |
| `source_uri` | yes | URL or local path for the source. |
| `source_commit` | when applicable | Upstream commit hash. |
| `source_tag` | when applicable | Upstream release tag. |
| `source_path` | yes | File(s) or sections used. |
| `source_corpus` | when applicable | Multi-skill source bundle, e.g. `LifeOS/install/skills`. |
| `source_skill_map` | when applicable | Source skills/workflows/templates that informed this record, with adopted/adapted/rejected disposition. |
| `license` | yes | License or `unknown`. |
| `provenance` | yes | `system`, `connector`, `user`, `agent_authored`, `external_adapted`, or `waldo_observed`. |
| `disposition` | yes | `adopt`, `adapt`, `reject`, `defer`, or `manual-only`, with a short boundary reason. |
| `adoption_scope` | yes | `repo-builder`, `vault-docs`, `human-contributor`, `runtime-candidate`, or `runtime-forbidden`. |
| `identity_locked` | yes | Whether the skill touches identity/personality/canon. |
| `protected_surface` | yes | Protected files or runtime surfaces the skill must not edit. |
| `required_tools` | yes | Tool ids from the tool manifest. |
| `required_connectors` | yes | Connectors or apps required to execute. |
| `required_scopes` | yes | Auth scopes or local permissions required. |
| `side_effect_level` | yes | `read-only`, `local-write`, `external-write`, `runtime-write`, `deploy`, or `destructive`. |
| `network_access` | yes | `none`, `source-verify`, `docs`, `external-api`, or `broad`. |
| `writes_allowed` | yes | Explicit write surfaces. |
| `privacy_tier` | yes | `public`, `repo-internal`, `user-private`, `health-adjacent`, `raw-health-forbidden`. |
| `sanitizer_policy` | yes | How external/user content is treated before skill use. |
| `health_data_access` | yes | `none`, `derived-only`, or `raw-forbidden`; raw health requires separate approval path. |
| `references` | yes | Reference files loaded by progressive disclosure. |
| `scripts` | no | Scripts provided by the skill. |
| `assets` | no | Images, templates, examples, or fixtures. |
| `resource_modalities` | yes | `text`, `code`, `image`, `video`, `dataset`, `repo`, `blog`, `book`, `paper`. |
| `status` | yes | `draft`, `provisional`, `active`, `pinned`, `deprecated`, `superseded`, `archived`. |
| `pinned` | yes | Whether lifecycle automation may archive it. |
| `provisional` | yes | Whether it is in trial mode. |
| `trial_started_at` | no | Trial start date. |
| `trial_expires_at` | no | Trial expiry date. |
| `effectiveness` | yes | Evidence summary or score. |
| `invocations` | yes | Count or pointer to logs. |
| `last_used` | no | Last invocation timestamp. |
| `eval_suite_id` | yes | Eval or pressure-test id. |
| `baseline_pass_rate` | no | No-skill baseline. |
| `with_skill_pass_rate` | no | With-skill result. |
| `token_overhead` | no | Approximate context cost. |
| `known_failure_modes` | yes | Failure cases and mitigations. |
| `hard_rejects` | when applicable | Source capabilities or assumptions that must not be imported. |
| `upstream_last_checked_at` | yes | Last source-verification date. |
| `upstream_sync_status` | yes | `current`, `stale`, `local-fork`, `unknown`, or `conflict`. |
| `supersedes` | no | Prior skill ids. |
| `superseded_by` | no | Replacement skill id. |

## Lifecycle Rules

- `draft`: incomplete or source-unverified.
- `provisional`: usable in bounded trials; must keep eval notes.
- `active`: source-backed, locally adapted, and pressure-tested.
- `pinned`: active and not auto-archivable.
- `deprecated`: still present for compatibility, not recommended.
- `superseded`: replaced by another registry record.
- `archived`: retained for audit only.

## Promotion Gate

A skill can move to `active` only when:

1. Source lineage is recorded.
2. Trigger condition is specific.
3. Tool manifest is complete enough for ACL decisions.
4. At least one pressure scenario exists.
5. Known failure modes are named.
6. Protected surfaces are explicit.
7. A no-skill baseline or rationale for skipping the baseline is recorded.
