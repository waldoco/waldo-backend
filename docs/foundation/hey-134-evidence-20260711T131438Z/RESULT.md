# HEY-134 Arch Linux Verification Result

- UTC timestamp: 2026-07-11T14:44:10Z
- Git commit: `8df1080be2e15c5c0ce9f615c92f983ee7673fc8`
- Arch kernel: `Linux archlinux 7.1.3-arch1-2 #1 SMP PREEMPT_DYNAMIC Thu, 09 Jul 2026 19:55:55 +0000 x86_64 GNU/Linux`
- Node version: `v26.4.0`
- npm version: `12.0.0`
- Docker version: `Docker version 29.6.1, build 8900f1d330`
- Supabase CLI: `2.109.1`
- pnpm: `10.34.4`
- Fresh migration chain: PASS (`db-start-from-zero.log`, `db-reset-from-zero.log`)
- pgTAP 44/44: PASS (`pgtap-schema-contract.log`)
- Helper absent: PASS (`0006-helper-absent.log`)
- Helper present hardening: FAIL in captured evidence (`0006-present-hardening-assertion.log` reports `function "public.rls_auto_enable()" does not exist`; this was patched afterward by making the fixture a single `DO` block and repeating helper ACL normalization in reconciliation)
- Exact migration history: PASS for canonical paths (`migration-history-assertion.log`, `verify-supabase-wrapper.log`, `final-migration-history.log`); helper-present-specific history log was not captured
- Idempotent migration up: PASS (`migration-up-idempotent.log`, `verify-supabase-wrapper.log`)
- Security advisors: NOT CAPTURED (`advisors-security.log` is absent from this evidence bundle)
- Performance advisors: PASS with INFO findings only (`advisors-performance.log`)
- Performance advisor findings:
  - INFO `unindexed_foreign_keys`: `chat_messages_parent_message_id_thread_id_fkey`
  - INFO `unindexed_foreign_keys`: `chat_messages_thread_id_user_id_fkey`
  - INFO `unindexed_foreign_keys`: `chat_messages_user_id_fkey`
  - INFO `unindexed_foreign_keys`: `chat_threads_user_id_fkey`
  - INFO `unindexed_foreign_keys`: `notification_log_user_id_fkey`
  - INFO `unindexed_foreign_keys`: `one_time_tokens_user_id_fkey`
  - INFO `unused_index`: `idx_patrol_entries_chain`
  - INFO `unused_index`: `idx_feedback_trace`
  - INFO `unused_index`: `idx_one_time_tokens_expires`
- Typecheck: PASS (`typecheck.log`)
- Contracts: PASS, 48 files / 1,168 tests (`contracts.log`)
- Guards: PASS (`guards.log`)
- Runtime: PASS, 16 files / 182 tests (`pnpm-verify.log`)
- Full `pnpm verify`: PASS, exit code `0` (`pnpm-verify.log`, `pnpm-verify-exit.txt`)
- `verify:supabase`: PASS (`verify-supabase-wrapper.log`)
- `git diff --check`: PASS (`git-diff-check-before.log`, `git-diff-check-final.log`)
- Clean git status: PASS initially (`initial-git-status.txt` empty); NOT CLEAN at final capture because HEY-134 patch files were modified (`final-git-status.txt`)
- Supabase containers stopped: PASS (`supabase-stop.log`, `docker-after-stop.log`)
- Shared Supabase access performed: NO

## Evidence Integrity Notes

- Evidence was copied into this repo at `docs/foundation/hey-134-evidence-20260711T131438Z/`.
- The local disposable Postgres URL in `local-status.log` was redacted in the repo copy.
- The source evidence directory was `/home/dev_086/hey-134-evidence-20260711T131438Z`.
- This result summarizes the copied logs exactly as found. Later local verification after the helper-present fixes passed, but those later runs are not present in this evidence bundle.
