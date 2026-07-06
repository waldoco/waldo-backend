# Tool Matrix

Every builder skill should declare tools as capabilities with safety semantics, not as a vague list of names.

## Tool Metadata

| Field | Meaning |
| --- | --- |
| `tool_name` | Stable local or connector tool id. |
| `provider` | Local shell, Codex, GitHub, Linear, Figma, Supabase, browser, simulator, etc. |
| `operation_kind` | Read, search, inspect, generate, write, execute, deploy, notify, delete. |
| `auth_scope` | Token, account, repo, org, project, tenant, or none. |
| `input_schema_ref` | Schema or contract for inputs. |
| `output_schema_ref` | Schema or expected output shape. |
| `data_classes_read` | Public, repo, user-private, health-adjacent, raw health, secrets, financial, etc. |
| `data_classes_written` | Same taxonomy for writes. |
| `requires_user_confirmation` | Yes/no and when. |
| `idempotency_support` | Native idempotency, synthetic id, replay-safe, not idempotent. |
| `rollback_or_undo` | How to restore or compensate. |
| `rate_limit_budget` | Expected call volume or external quota. |
| `cost_estimate` | Free, low, medium, high, unknown. |
| `sanitizer_required` | Whether external/user content must be sanitized. |
| `audit_log_event` | Event name for logs. |
| `offline_test_double` | Mock, fixture, local sample, or none. |
| `timeout_policy` | Short, bounded long-run, monitor, or user-confirmed. |
| `retry_policy` | None, safe retry, backoff, manual retry only. |
| `availability_probe` | Command or check proving the tool is usable. |

## Default Capability Bundles

| Bundle | Tools | Use |
| --- | --- | --- |
| Source verifier | Git, GitHub/raw HTTP, browser search, arXiv/Hugging Face pages | Rechecking upstream source state. |
| Vault editor | `rg`, file read, `apply_patch`, Markdown/frontmatter parsing | Updating repo-local skills and Obsidian pages. |
| Skill validator | Node script, YAML/frontmatter parser, hash/checksum, git diff | Checking registry shape and mirror drift. |
| Engineering verifier | Test runner, typecheck, build, lint, git diff, code review | Proving code-facing skills changed behavior safely. |
| UI verifier | Browser, Playwright/simulator, screenshots, trace/video, viewport matrix | Proving design/motion output rendered correctly. |
| Runtime gate | Loader ACL, connector availability, tenant/user scope, sanitizer, audit log | Future Waldo product skill activation. |
| Memory proposal | GoalRecord/memory proposal API, approval UI, snapshot/rollback, tenant scoping | Reviewing persistent memory or goal updates. |
| LifeOS source adoption | Git/GitHub, local source checkout, `rg`, subagents, source maps, citation notes | Auditing multi-skill source corpora and converting them into Waldo records. |
| Research verifier | Web/search, official APIs, arXiv, local source files, citation notes | Verifying claims by content, tagging confidence, and preserving conflicts. |
| Agent orchestration | Multi-agent tools, role/source packets, observer/verifier prompts, synthesis notes | Running bounded parallel audits with post-run spotchecks. |
| Hardening gate | Test runner, property-test framework where available, mutation/adversarial checklist, deterministic seeds | Testing criteria, parsers, manifests, ACLs, reconcile logic, and state transitions. |
| Browser evidence | Isolated browser/simulator, screenshots, DOM/state probe, console and network logs | Verifying UI/deploy/runtime claims with a conjunctive evidence bundle. |
| Creative/narrative eval | Source packet, scoring rubric, judge/comparison templates, anti-cliche checklist | Evaluating ideation, product story, UX copy, and founder-intent preservation. |
| Knowledge graph analyzer | Understand Anything `/understand*` skills, local git, `.understandignore`, graph dashboard, source files | Building and inspecting repo/vault graphs for onboarding, architecture review, diff impact, domain mapping, and reference graph hygiene. |
| Every plan artifact reviewer | File reads, Markdown/frontmatter parser, source citations, issue/PR context, test/build commands | Checking requirements-only vs implementation-ready state, stable IDs, Product Contract, Planning Contract, Verification Contract, and Definition of Done. |
| Every review residual sink | Git diff, test runner, issue/PR tools, Markdown editor, Evidence Trail | Ensuring review findings are fixed, filed, explicitly accepted, or deferred with durable owner/context. |
| Every compound refresh | `rg`, git history, Markdown/frontmatter parser, source verifier, `apply_patch` | Auditing stale, overlapping, superseded, or misleading learning docs without auto-deleting Waldo pages. |
| Every feedback sweep | Slack/GitHub/email connectors, sanitizer, state store, single-writer lease, audit log, issue/PR tools | Future user/product feedback pipeline with sensitive-content redaction and untrusted-input handling. |
| Every optimization loop | Test/eval runner, benchmark fixtures, judge harness where needed, experiment log, git diff | Running metric-driven experiments with disk-durable logs and keep/revert decisions. |
| Every product/design proof | Dev server, browser/simulator, screenshots/traces, console/network logs, Figma/design references | Verifying prototype, polish, and design-taste claims through rendered evidence. |

## Authority Rule

`allowed-tools` in a source skill can be preserved as metadata, but Waldo authorization must be enforced by loader and runtime ACLs. The registry should let a skill say what it wants; the runtime decides what it may do.
