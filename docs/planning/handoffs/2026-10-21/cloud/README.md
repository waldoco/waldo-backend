# Cloud orchestration tooling (C0, 21–22 Oct 2026)

The tools the cloud orchestrator and its lane children use. Another cloud session can pick them up from here.

- `LANE_BRIEF.md`: the brief every lane child reads first. It covers the rules, the shared-machine limits, the Ready protocol and the "search open PRs before you start an issue" check.
- `wall.sh`: the local wall runner. Copy it to `/home/user/wt/wall.sh` and run `bash /home/user/wt/wall.sh "$PWD"` from a worktree root. It runs every `pnpm verify` segment on its own, in two lock slots, and writes `.wall/<sha>.txt`. In this cloud container `verify:supabase` and `guard-pgtap` are UNAVAILABLE (images and Postgres packages can't be fetched), and `verify:workers` is NOT RUN locally, so PR CI's four shards decide it.
- `logrow.py`: appends one row to the Progress log in `../README.md`, and can optionally replace an owner-ask paragraph.

Wall files from lane runs were kept in `/home/user/wt/walls/` in the container. They're evidence for the Ready claims logged in `../README.md`; each Ready comment on GitHub quotes its wall table.
