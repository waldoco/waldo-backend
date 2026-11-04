# PR consolidation sweep

**Owner:** a short-lived Claude session. Repo: `waldoco/waldo-backend`.

## Why

There are 71 open PRs, and 51 of them have not been updated since 8 Oct. Every new lane re-audits them; the browser lane spent its first hours doing exactly that.

## Task

1. **For each open PR, record one disposition with evidence:**
   - **land:** still valuable and not on `beta-mvp`;
   - **re-cut source:** its content belongs to a named lane; say which files and which lane;
   - **close:** already on `beta-mvp`, or superseded. Name the PR or SHA that superseded it. Squash merges defeat `git cherry`, so compare content.
2. **Write the table as a #116 comment.**
3. **Ask the owner for the close go in batches.** Close only what the owner approved, each with a one-line comment naming its replacement.

## Exclude, never close

- Ashish's PRs: #1006, #1017.
- PRs in flight from the active lanes: #1029–#1034.
- Re-cut sources: #998, #915, #931, #932.
- This docs PR.

## Starting evidence

- Browser drafts: #1032 already audits #881, #894, #895, #906, #908, #911, #941, #966, #973 and #987.
- Pin branches marked "DO NOT MERGE": #840, #847.
- Google stack, overlapping: #902 → #903 → #905/#907 → #919, plus #910, #912, #913. Several reads landed later (#1008, #1015, #1019), so audit them against `beta-mvp`.
