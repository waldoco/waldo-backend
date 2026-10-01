import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { provisionDoSchema } from '../src/do-schema';
import { SqliteSystemSkillRepository } from '../src/context-composer/sqlite';
import type { SystemSkillRepository } from '../src/context-composer';
import { acceptTrustedInvocation, skillRowSchema } from '@waldo/contracts';
import { expect, it, vi } from 'vitest';
import {
  localTrustedBriefScheduleInput,
  localTrustedBriefTurnSnapshot,
  resolveRunLoopAdapters,
} from '../src/run-loop/adapters';
import { JoinedConversationPath } from '../src/conversation/joined-path';
const fixture = localTrustedBriefScheduleInput();
const accepted = acceptTrustedInvocation(fixture.admission);
if (!accepted.ok) throw Error('admission');
const invocation = accepted.value;
const principal = invocation.verified_authority.principal_ref,
  tenant = invocation.verified_authority.tenant_ref;
const canary_tokens = [
  '0123456789abcdef',
  'fedcba9876543210',
  '0011223344556677',
];
const row = (name = 'fixture-procedure') =>
  skillRowSchema.parse({
    name,
    version: 1,
    provenance: 'system',
    identity_locked: true,
    provisional: false,
    trigger_types: ['brief'],
    trigger_condition: 'a practical brief',
    required_tools: [],
    required_connectors: [],
    effectiveness: 0.9,
    invocations: 0,
    last_used: null,
    body_markdown: 'Keep fixture decisions inspectable.',
    created_at: '2026-09-30T08:00:00Z',
    created_by: 'test-fixture-not-production-seed',
    status: 'active',
    pinned: false,
    last_curated_at: null,
    archived_at: null,
  });
const repository = (rows = [row()]) => ({
  list: async (r: { snapshot_ref: string; snapshot_at: number }) => ({
    rows,
    snapshot: { ...r, revision_ref: 'rev_99999999999999999999999999999999' },
    source: {
      source_key: 'test-host-skill-repo',
      source_kind: 'runtime_metadata' as const,
      scope: 'system' as const,
      source_taint: null,
      produced_at: r.snapshot_at,
    },
  }),
});
const budget = {
  countRenderedSkill: async () => ({ ok: true as const, tokens: 15 }),
  countRenderedBlock: async () => ({ ok: true as const, tokens: 15 }),
};
const opts = (repo: SystemSkillRepository = repository()) => ({
  localSystemSkills: {
    principal_ref: principal,
    tenant_ref: tenant,
    repository: repo,
    budget,
  },
});
const compose = async (
  options: Parameters<typeof resolveRunLoopAdapters>[1],
  snapshot = localTrustedBriefTurnSnapshot(),
) =>
  resolveRunLoopAdapters(
    { WALDO_ENV: 'local' },
    options,
  ).contextComposer!.compose(invocation, {
    ...snapshot,
    canary_tokens,
    replay_context_ref: null,
  });
it('red: host system row reaches joined prompt at a live timestamp', async () => {
  const result = await compose(opts());
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.prompt).toContain('Keep fixture decisions inspectable.');
});
it('default omitted dependency remains identical to explicit omission', async () => {
  const snapshot = localTrustedBriefTurnSnapshot();
  expect(await compose({}, snapshot)).toEqual(
    await compose(undefined, snapshot),
  );
});
it('historical July16 cannot admit newer skill, live and +60s can', async () => {
  expect((await compose(opts(), fixture)).ok).toBe(false);
  expect(
    (
      await compose(opts(), {
        ...localTrustedBriefTurnSnapshot(),
        snapshot_at: Date.now() + 59000,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await compose(opts(), {
        ...localTrustedBriefTurnSnapshot(),
        snapshot_at: Date.now() + 61000,
      })
    ).ok,
  ).toBe(false);
});
it('24 row sentinel accepted,25+ rejected', async () => {
  for (const n of [24, 25, 26])
    expect(
      (
        await compose(
          opts(
            repository(Array.from({ length: n }, (_, i) => row(`test-${i}`))),
          ),
        )
      ).ok,
    ).toBe(n === 24);
});
it('wrong owner host fails closed and never reads repository', async () => {
  const repo = repository();
  const spy = vi.spyOn(repo, 'list');
  expect(
    (
      await compose({
        localSystemSkills: {
          ...opts().localSystemSkills,
          principal_ref: 'prn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          repository: repo,
        },
      })
    ).ok,
  ).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
it('absent schema/load error fails closed; no legacy fallback', async () => {
  expect(
    (
      await compose(
        opts({
          list: async () => {
            throw Error('no table skills');
          },
        }),
      )
    ).ok,
  ).toBe(false);
});
it('unlocked/non-system/body oversize rows reject, no silent rewriting', async () => {
  for (const changes of [
    { identity_locked: false },
    { provenance: 'agent_authored' },
    { body_markdown: 'x'.repeat(100000) },
  ])
    expect(
      (await compose(opts(repository([{ ...row(), ...changes } as never])))).ok,
    ).toBe(false);
});
it('async load resumed after close cannot call model or publish final', async () => {
  let release!: () => void;
  const paused = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const repo = repository();
  const composer = resolveRunLoopAdapters(
    { WALDO_ENV: 'local' },
    opts({
      list: async (r) => {
        entered();
        await paused;
        return repo.list(r);
      },
    }),
  ).contextComposer!;
  let live = true;
  const complete = vi.fn(async () => 'answer');
  const path = new JoinedConversationPath(composer, { complete });
  const admit = () => {
    if (!live) throw Error('closed');
  };
  const pending = path.submit({
    authenticatedOwnerId: principal,
    invocation,
    context: {
      ...localTrustedBriefTurnSnapshot(),
      canary_tokens,
      replay_context_ref: null,
    },
    runScope: {
      runId: 'run',
      attempt: '1',
      deadline: Date.now() + 10000,
      signal: new AbortController().signal,
      admit,
      commit: (w) => {
        admit();
        return w();
      },
    },
    userEntry: {
      id: 't',
      ownerId: principal,
      chatId: 'local',
      parentId: null,
      threadAnchorId: null,
      surface: 'telegram',
      modelPayload: 'brief',
      appPayload: 'brief',
      modelProjection: { mode: 'include' },
    },
    assistantEntryId: 'a',
  });
  await ready;
  live = false;
  release();
  await expect(pending).rejects.toThrow('closed');
  expect(complete).not.toHaveBeenCalled();
});
it('gateway refuses private local repository rather than silently dropping it', () => {
  expect(() =>
    resolveRunLoopAdapters(
      { WALDO_ENV: 'staging', RUN_LOOP_PROVIDER_MODE: 'gateway' },
      opts(),
    ),
  ).toThrow('local-only');
});
it('real host SQLite snapshot attests content and composes without provisioning by loader', async () => {
  const stub = env.RUNTIME_DO.get(
    env.RUNTIME_DO.idFromName('private-skills-present'),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    // Existing schema helper only for isolated test fixture. Runtime seam never calls it.
    provisionDoSchema(state.storage);
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO skills (name,version,provenance,identity_locked,provisional,trigger_types_json,trigger_condition,required_tools_json,required_connectors_json,effectiveness,invocations,last_used,body_markdown,created_at,created_by,status,pinned,last_curated_at,archived_at) VALUES (?,1,'system',1,0,'["brief"]','practical brief','[]','[]',0.9,0,NULL,?,'2026-09-30T08:00:00Z','test-only','active',0,NULL,NULL)`,
      'real-sqlite-fixture',
      'SQLite host fixture reached prompt.',
    );
    const repo = new SqliteSystemSkillRepository(
      sql,
      'rev_11111111111111111111111111111111',
    );
    const snapshot = localTrustedBriefTurnSnapshot();
    const first = await repo.list(snapshot);
    expect(first.snapshot.snapshot_at).toBe(snapshot.snapshot_at);
    expect(first.snapshot.revision_ref).not.toBe(
      'rev_11111111111111111111111111111111',
    );
    const result = await compose(opts(repo), snapshot);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.prompt).toContain('SQLite host fixture reached prompt.');
  });
});
it('real absent-table host stays absent after fail-closed compose, no DDL or fallback', async () => {
  const stub = env.RUNTIME_DO.get(
    env.RUNTIME_DO.idFromName('private-skills-absent'),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const repo = new SqliteSystemSkillRepository(
      state.storage.sql,
      'rev_11111111111111111111111111111111',
    );
    expect((await compose(opts(repo))).ok).toBe(false);
    expect(() =>
      state.storage.sql.exec('SELECT name FROM skills').toArray(),
    ).toThrow();
  });
});
it('actual model resume after closed scope cannot publish or cache final', async () => {
  let release!: (s: string) => void;
  const paused = new Promise<string>((r) => (release = r));
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  let live = true;
  const composer = resolveRunLoopAdapters(
    { WALDO_ENV: 'local' },
    opts(),
  ).contextComposer!;
  const path = new JoinedConversationPath(composer, {
    complete: async () => {
      entered();
      return paused;
    },
  });
  const admit = () => {
    if (!live) throw Error('closed');
  };
  const pending = path.submit({
    authenticatedOwnerId: principal,
    invocation,
    context: {
      ...localTrustedBriefTurnSnapshot(),
      canary_tokens,
      replay_context_ref: null,
    },
    runScope: {
      runId: 'run',
      attempt: '1',
      deadline: Date.now() + 10000,
      signal: new AbortController().signal,
      admit,
      commit: (w) => {
        admit();
        return w();
      },
    },
    userEntry: {
      id: 'model-resume',
      ownerId: principal,
      chatId: 'local',
      parentId: null,
      threadAnchorId: null,
      surface: 'telegram',
      modelPayload: 'brief',
      appPayload: 'brief',
      modelProjection: { mode: 'include' },
    },
    assistantEntryId: 'model-final',
  });
  await ready;
  live = false;
  release('stale final');
  await expect(pending).rejects.toThrow('closed');
  expect(path.read(principal, 'model-final')).toBeUndefined();
});
