import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { approveTaskSourceProposal, createTaskSourceScope, TASK_SOURCE_FAMILIES, taskSourceAllowed } from '../src/channels/task-source-scope';
import { taskSourceClient } from '../src/tools/task-source-io';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const run = (name: string, work: (sql: SqlStorage, scope: RunEffectScope) => Promise<void>) => runInDurableObject(
  env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const scope: RunEffectScope = { runId: name, attempt: 'test', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit() {}, commit: fn => fn() };
    await work(state.storage.sql, scope);
  });
const decision = (value: string, sources: readonly string[] = []) => JSON.stringify({ decision: value, sources });

it('recreated custody preserves narrowed sources and retain cannot grant classifier-supplied sources', () => run('task-custody-recreate', async (sql, scope) => {
  const capability = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  const restricted = (await capability.classify(decision('restrict'))).snapshot;
  expect(taskSourceAllowed(restricted, { name: 'search_communication', requires_connector: true })).toBe(false);
  const recreated = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  const retained = (await recreated.classify(decision('retain', TASK_SOURCE_FAMILIES))).snapshot;
  expect(retained.sources).toEqual([]);
  expect(taskSourceAllowed(retained, { name: 'workspace_render', mutates_state: true })).toBe(false);
  expect(sql.exec<{ sources_json: string }>('SELECT sources_json FROM owner_task_source_scope').one().sources_json).toBe('[]');
}));

it('malformed and uncertain decisions fail closed without erasing active restrictions', () => run('task-custody-failure', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  await cap.classify(decision('restrict', ['mail']));
  for (const raw of ['not json', decision('restrict', ['invented']), JSON.stringify({ decision: 'retain', sources: [], ownerText: 'forbidden retention' }), decision('uncertain')]) {
    const result = await cap.classify(raw);
    expect(result.snapshot.ready).toBe(false);
    expect(result.snapshot.sources).toEqual(['mail']);
    expect(taskSourceAllowed(result.snapshot, { name: 'search_communication', requires_connector: true })).toBe(false);
  }
  expect(JSON.stringify(sql.exec('SELECT * FROM owner_task_source_scope').toArray())).not.toContain('forbidden retention');
}));

it('new, change and close need exact single-use owner decisions; expiry does not drop restrictions', () => run('task-custody-decisions', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  await cap.classify(decision('restrict'));
  for (const action of ['change', 'new', 'close']) {
    const { snapshot, proposal } = await cap.classify(decision(action, ['mail']));
    expect(proposal).toBeDefined();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.sources).toEqual([]);
    expect(approveTaskSourceProposal(sql, 'foreign-owner', proposal!, Date.now(), scope)).toBe(false);
    expect(approveTaskSourceProposal(sql, 'owner-one', { ...proposal!, nonce: 'forged' }, Date.now(), scope)).toBe(false);
    expect(approveTaskSourceProposal(sql, 'owner-one', proposal!, proposal!.expiresAt, scope)).toBe(false);
    expect((await cap.current()).sources).toEqual([]);
    expect(approveTaskSourceProposal(sql, 'owner-one', proposal!, Date.now(), scope)).toBe(true);
    expect(approveTaskSourceProposal(sql, 'owner-one', proposal!, Date.now(), scope)).toBe(false);
    const approved = await cap.current();
    expect(approved.sources).toEqual(action === 'close' ? [] : ['mail']);
    expect(approved.taskId === snapshot.taskId).toBe(action === 'change');
    await cap.classify(decision('restrict'));
  }
}));

it('stale cards and captured read snapshots cannot outlive a task revision', () => run('task-custody-revision', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  const previous = (await cap.classify(decision('retain'))).snapshot;
  await cap.classify(decision('restrict'), 'pasted-start');
  const proposal = (await cap.classify(decision('change', ['mail']))).proposal!;
  await cap.classify(decision('restrict'));
  expect(approveTaskSourceProposal(sql, 'owner-one', proposal, Date.now(), scope)).toBe(false);
  await expect(cap.assertSame(previous)).rejects.toThrow('Task source scope changed');
}));

it('fresh owner checks fence custody reads and changes', () => run('task-custody-owner', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => { throw new Error('Owner changed'); });
  await expect(cap.classify(decision('retain'))).rejects.toThrow('Owner changed');
  expect(sql.exec<{ revision: number }>('SELECT revision FROM owner_task_source_scope').one().revision).toBe(1);
}));

it('client operations recheck after authentication and withhold results if scope changes during IO', async () => {
  let current = true;
  const physical = vi.fn(async () => 'private fixture');
  const ctx = { assertTaskSourceCurrent: async () => { if (!current) throw new Error('Task changed'); } } as ToolDispatcherContext;
  const client = taskSourceClient({ read: physical }, ctx);
  current = false;
  await expect(client.read()).rejects.toThrow('Task changed');
  expect(physical).not.toHaveBeenCalled();
  current = true;
  physical.mockImplementationOnce(async () => { current = false; return 'private fixture'; });
  await expect(client.read()).rejects.toThrow('Task changed');
  expect(physical).toHaveBeenCalledTimes(1);
});

it('Gmail transport fences internal list-to-message reads after a scope change', async () => {
  const { googleClient } = await import('../src/connectors/google');
  const { taskSourceFetch } = await import('../src/tools/task-source-io');
  let current = true;
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'synthetic-token' });
    current = false;
    return Response.json({ messages: [{ id: 'synthetic-message' }] });
  };
  const client = googleClient({ clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://fixture.invalid' }, { refresh_token: 'fixture' }, taskSourceFetch(async () => { if (!current) throw new Error('Task changed'); }, fetcher));
  await expect(client.searchMail('fictional', 1)).rejects.toThrow('Task changed');
  expect(calls).toHaveLength(2); // token + list only; no message content fetch
});

it('browser scope change during session start prevents navigation while still closing the session', async () => {
  const { browsePageHandler } = await import('../src/tools/live/browser');
  let current = true;
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/start')) { current = false; return Response.json({ success: true, data: { sessionId: 'fixture-session' } }); }
    return Response.json({ success: true });
  };
  const handler = browsePageHandler('fixture', 'fixture', 'fixture', fetcher);
  const result = await handler.handle({ url: 'https://fixture.invalid', instruction: 'read fictional text' }, { assertTaskSourceCurrent: async () => { if (!current) throw new Error('Task changed'); } } as ToolDispatcherContext);
  expect(result.ok).toBe(false);
  expect(calls.map(url => url.split('/').at(-1))).toEqual(['start', 'end']);
});

it('render/export and an edit read require workspace scope, while creating supplied bytes remains possible', () => {
  const snapshot = { taskId: 'task', revision: 1, sources: [] as const, ready: true, startRef: 'input' };
  expect(taskSourceAllowed(snapshot, { name: 'workspace_render', mutates_state: true })).toBe(false);
  expect(taskSourceAllowed(snapshot, { name: 'export_artifact', mutates_state: true })).toBe(false);
  expect(taskSourceAllowed(snapshot, { name: 'workspace_write', mutates_state: true }, { expected_revision: 1, edits: [] })).toBe(false);
  expect(taskSourceAllowed(snapshot, { name: 'workspace_write', mutates_state: true }, { expected_revision: 0, text: 'supplied bytes' })).toBe(true);
});

it('workspace render rechecks after awaited store admission before exporting source bytes', async () => {
  const { workspaceRenderHandler } = await import('../src/tools/live/workspace-render');
  let current = true;
  const physical = vi.fn(async () => { throw new Error('Must not read'); });
  const handler = workspaceRenderHandler(async () => { await Promise.resolve(); current = false; return { export: physical } as never; });
  const result = await handler.handle({ source_file_id: 'file', source_revision: 1, path: 'result.pdf', expected_revision: 0, format: 'pdf' }, { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call', assertTaskSourceCurrent: async () => { if (!current) throw new Error('Task changed'); } } as ToolDispatcherContext);
  expect(result.ok).toBe(false);
  expect(physical).not.toHaveBeenCalled();
});

it('Vault-backed MCP reads recheck after awaited grant resolution before proxy dispatch', async () => {
  const { readMcpToolHandler } = await import('../src/tools/live/mcp');
  let current = true;
  const physical = vi.fn(async () => 'private source');
  const resolve = vi.fn(async () => { await Promise.resolve(); current = false; return { mode: 'proxy' as const, connection: 'fixture' }; });
  const handler = readMcpToolHandler(JSON.stringify([{ name: 'drive', url: 'https://drive.googleapis.com/mcp', auth: 'google', requires: 'drive', allow_tools: ['list_recent_files'], read_tools: ['list_recent_files'] }]), {
    resolve, proxy: physical,
  }, true);
  const result = await handler.handle({ server: 'drive', tool: 'list_recent_files', args: {} }, { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call', assertTaskSourceCurrent: async () => { if (!current) throw new Error('Task changed'); } } as ToolDispatcherContext);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(false);
  expect(physical).not.toHaveBeenCalled();
});

it('an owner-confirmed new task or source change can continue without repeating the same confirmation', () => run('scope-confirmed-retry', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {});
  await cap.classify(decision('restrict'), 'pasted-task-start');
  const next = await cap.classify(decision('new', ['mail']), 'new-request');
  expect(approveTaskSourceProposal(sql, 'owner', next.proposal!, Date.now(), scope)).toBe(true);
  const retried = await cap.classify(decision('new', ['mail']), 'new-request-retry');
  expect(retried.proposal).toBeUndefined();
  expect(retried.snapshot.ready).toBe(true);
  expect(retried.snapshot.sources).toEqual(['mail']);
  expect(retried.snapshot.startRef).toBe('new-request-retry');
  const changed = await cap.classify(decision('change', ['mail', 'calendar']), 'change-request');
  expect(changed.proposal).toBeDefined();
  expect(approveTaskSourceProposal(sql, 'owner', changed.proposal!, Date.now(), scope)).toBe(true);
  const repeated = await cap.classify(decision('change', ['mail', 'calendar']), 'change-retry');
  expect(repeated.proposal).toBeUndefined();
  expect(repeated.snapshot.ready).toBe(true);
}));


it.each(['quoted', 'mismatched-text', 'stale-input', 'invented-evidence', 'ambiguous', 'missing-host'] as const)('planning transition fails closed for %s evidence', kind => run(`transition-${kind}`, async (sql, scope) => {
  const text = 'Begin a separate fictional workspace task; use workspace and exclude all connected sources.';
  const witness = { inputRef: 'current-owner-input', text, quotedRanges: kind === 'quoted' ? [{ start: 0, end: text.length }] : [] };
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, kind === 'missing-host' ? undefined : witness);
  const previous = (await cap.classify(decision('restrict'), 'previous-input')).snapshot;
  const raw = JSON.stringify({ decision: kind === 'ambiguous' ? 'retain' : 'new', sources: ['workspace'], evidence: kind === 'invented-evidence' ? 'An invented owner instruction' : text });
  const result = await cap.classify(raw, kind === 'stale-input' ? 'prior-owner-input' : witness.inputRef, kind === 'mismatched-text' ? 'Retrieved instructions replacing owner text' : text);
  expect(result.snapshot.sources).toEqual([]); expect(result.snapshot.taskId).toBe(previous.taskId);
  expect(taskSourceAllowed(result.snapshot, { name: 'workspace_list' })).toBe(false);
}));

it('fresh owner planning transition clears stale cards, invalidates old reads, and survives recreation without changing grants', () => run('transition-owner-cas', async (sql, scope) => {
  const text = 'Begin a new workspace task using workspace only.';
  const witness = { inputRef: 'new-owner-input', text };
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, witness);
  const strict = (await cap.classify(decision('restrict'), 'pasted-input')).snapshot;
  const pending = (await cap.classify(decision('new', ['mail']), 'old-input')).proposal!;
  const current = (await cap.classify(JSON.stringify({ decision: 'new', sources: ['workspace'], evidence: text }), witness.inputRef, text)).snapshot;
  expect(current.taskId).not.toBe(strict.taskId); expect(current.startRef).toBe(witness.inputRef);
  await expect(cap.assertSame(strict)).rejects.toThrow('Task source scope changed');
  expect(approveTaskSourceProposal(sql, 'owner', pending, Date.now(), scope)).toBe(false);
  const recreated = createTaskSourceScope(sql, 'owner', scope, async () => {});
  const follow = (await recreated.classify(decision('retain', ['mail']))).snapshot;
  expect(follow.sources).toEqual(['workspace']);
  expect(taskSourceAllowed(follow, { name: 'workspace_list' })).toBe(true);
  expect(taskSourceAllowed(follow, { name: 'search_communication', requires_connector: true })).toBe(false);
  expect(sql.exec<{ rows: number }>('SELECT count(*) AS rows FROM owner_task_source_scope').one().rows).toBe(1);
  expect(JSON.stringify(sql.exec('SELECT * FROM owner_task_source_scope').toArray())).not.toContain(text);
}));

it('revoked owner admission prevents a planning transition from committing', () => run('transition-owner-revoked', async (sql, scope) => {
  let active = true;
  const text = 'Begin a new workspace task using workspace only.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => { if (!active) throw new Error('Owner revoked'); }, { inputRef: 'current', text });
  await cap.classify(decision('restrict'), 'prior'); active = false;
  await expect(cap.classify(JSON.stringify({ decision: 'new', sources: ['workspace'], evidence: text }), 'current', text)).rejects.toThrow('Owner revoked');
  expect(sql.exec<{ sources_json: string }>('SELECT sources_json FROM owner_task_source_scope').one().sources_json).toBe('[]');
}));


it('explicit same-task source change preserves identity and close retires reads until a fresh explicit task', () => run('transition-change-close', async (sql, scope) => {
  const initial = createTaskSourceScope(sql, 'owner', scope, async () => {});
  const strict = (await initial.classify(decision('restrict'), 'pasted-input')).snapshot;
  const text = 'For this task, use workspace only.';
  const change = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'change-input', text });
  const changed = (await change.classify(JSON.stringify({ decision: 'change', sources: ['workspace'], evidence: text }), 'change-input', text)).snapshot;
  expect(changed.taskId).toBe(strict.taskId); expect(changed.startRef).toBe('pasted-input');
  expect(changed.sources).toEqual(['workspace']);
  const closeText = 'Close the current task.';
  const close = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'close-input', text: closeText });
  const closed = (await close.classify(JSON.stringify({ decision: 'close', sources: [], evidence: closeText }), 'close-input', closeText)).snapshot;
  expect(closed.taskId).not.toBe(changed.taskId); expect(closed.ready).toBe(false); expect(closed.sources).toEqual([]);
  const ambiguous = (await close.classify(decision('retain', ['mail']), 'follow-input')).snapshot;
  expect(ambiguous.sources).toEqual([]);
}));


it.each(['invalid', 'uncertain'] as const)('fresh owner %s recovery retains strict pasted-only sources without adding classifier families', kind => run(`recovery-strict-${kind}`, async (sql, scope) => {
  const text = 'Which Alex is that going to?';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'followup', text });
  const strict = (await cap.classify(decision('restrict'), 'pasted-start')).snapshot;
  const raw = kind === 'invalid' ? 'not json' : JSON.stringify({ decision: 'uncertain', sources: ['mail', 'workspace'], evidence: null });
  const result = await cap.classify(raw, 'followup', text);
  expect(result.snapshot.taskId).toBe(strict.taskId); expect(result.snapshot.startRef).toBe(strict.startRef);
  expect(result.snapshot.sources).toEqual([]); expect(result.outcome).toBe(kind === 'invalid' ? 'invalid_decision' : 'uncertain');
  for (const name of ['search_communication', 'workspace_list', 'web_search'] as const) expect(taskSourceAllowed(result.snapshot, { name })).toBe(false);
}));

it.each(['baseline', 'unready', 'closed', 'pending', 'quoted', 'steering', 'stale-input'] as const)('invalid classification never recovers %s custody', kind => run(`recovery-deny-${kind}`, async (sql, scope) => {
  const text = 'Use the current workspace notes.';
  const witness = { inputRef: 'current', text, quotedRanges: kind === 'quoted' ? [{ start: 0, end: text.length }] : [] };
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, witness);
  if (kind !== 'baseline') await cap.classify(decision('restrict', ['workspace']), 'workspace-start');
  if (kind === 'unready') await cap.unresolved();
  if (kind === 'pending') await cap.classify(decision('change', ['workspace', 'mail']), 'old-input');
  if (kind === 'closed') {
    const closeText = 'Close the current task.';
    const close = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'close', text: closeText });
    await close.classify(JSON.stringify({ decision: 'close', sources: [], evidence: closeText }), 'close', closeText);
  }
  const before = await cap.current();
  const result = await cap.classify('not json', kind === 'stale-input' ? 'old-input' : 'current', text);
  expect(result.outcome).toBe(kind === 'pending' ? 'owner_confirmation' : 'invalid_decision'); expect(result.snapshot.ready).toBe(false);
  expect(result.snapshot.taskId).toBe(before.taskId); expect(result.snapshot.sources).toEqual(before.sources);
  expect(taskSourceAllowed(result.snapshot, { name: 'workspace_list' })).toBe(false);
}));

it('valid restrictive instructions take precedence over same-scope recovery', () => run('recovery-narrow', async (sql, scope) => {
  const text = 'Use only supplied fictional material now.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => {}, { inputRef: 'current', text });
  await cap.classify(decision('restrict', ['workspace']), 'workspace-start');
  const result = await cap.classify(JSON.stringify({ decision: 'restrict', sources: [], evidence: null }), 'current', text);
  expect(result.snapshot.sources).toEqual([]); expect(result.outcome).toBe('restricted');
  expect(taskSourceAllowed(result.snapshot, { name: 'workspace_list' })).toBe(false);
}));

it('a concurrent restriction wins CAS while an invalid-decision recovery is suspended', () => run('recovery-cas', async (sql, scope) => {
  let gated = false; let calls = 0; let entered!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }); const paused = new Promise<void>(resolve => { release = resolve; });
  const text = 'Derive a plan from the current workspace notes.';
  const cap = createTaskSourceScope(sql, 'owner', scope, async () => { if (gated && ++calls === 2) { entered(); await paused; } }, { inputRef: 'current', text });
  await cap.classify(decision('restrict', ['workspace']), 'workspace-start'); gated = true;
  const recovery = cap.classify('not json', 'current', text);
  await reached;
  const concurrent = createTaskSourceScope(sql, 'owner', scope, async () => {});
  await concurrent.classify(decision('restrict'), 'new-restriction'); release();
  await expect(recovery).rejects.toThrow('Task source scope changed');
  expect((await concurrent.current()).sources).toEqual([]);
}));

it('the owner\'s own chat reads connected mail and calendar by default; an explicit narrowing is never undone', () => run('task-custody-defaults', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {}, undefined, ['mail', 'calendar']);
  sql.exec(`UPDATE owner_task_source_scope SET sources_json = '["workspace","web"]', ready = 1 WHERE owner_key = 'owner-one'`);
  const retained = (await cap.classify(decision('retain'))).snapshot;
  expect(retained.sources).toEqual(expect.arrayContaining(['workspace', 'web', 'mail', 'calendar']));
  expect(taskSourceAllowed(retained, { name: 'search_communication', requires_connector: true })).toBe(true);
  const narrowed = (await cap.classify(decision('restrict'))).snapshot;
  expect(narrowed.sources).toEqual([]);
  const after = (await cap.classify(decision('retain'))).snapshot;
  expect(after.sources, 'a later retain must not bring mail back after the owner narrowed the task').toEqual([]);
}));

it('without host defaults a retained task never gains mail or calendar', () => run('task-custody-no-defaults', async (sql, scope) => {
  const cap = createTaskSourceScope(sql, 'owner-one', scope, async () => {});
  sql.exec(`UPDATE owner_task_source_scope SET sources_json = '["workspace","web"]', ready = 1 WHERE owner_key = 'owner-one'`);
  expect((await cap.classify(decision('retain'))).snapshot.sources).toEqual(['workspace', 'web']);
}));

it('owner default read sources: public web always, Google families only once Google is connected', async () => {
  const { ownerReadSources } = await import('../src/channels/task-source-scope');
  expect(ownerReadSources([])).toEqual(['local', 'workspace', 'web']);
  expect(ownerReadSources([{ id: 'g' }])).toEqual(expect.arrayContaining(['local', 'workspace', 'web', 'mail', 'calendar', 'contacts', 'tasks', 'drive']));
});

const DEFAULTS = ['mail', 'calendar'] as const;
const owned = (sql: SqlStorage, scope: RunEffectScope, defaults: readonly string[] = DEFAULTS, text = 'plan my trip', ref = 'r1') => createTaskSourceScope(sql, 'owner-one', scope, async () => {}, { inputRef: ref, text }, defaults as never);
const narrowedFlag = (sql: SqlStorage) => sql.exec<{ narrowed: number }>('SELECT narrowed FROM owner_task_source_scope').one().narrowed;
const legacyTable = (sql: SqlStorage, sources: string, ready = 1) => {
  sql.exec('CREATE TABLE owner_task_source_scope (owner_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, sources_json TEXT NOT NULL, ready INTEGER NOT NULL, pending_json TEXT, start_ref TEXT)');
  sql.exec(`INSERT INTO owner_task_source_scope VALUES ('owner-one', 't1', 1, ?, ?, NULL, NULL)`, sources, ready);
};

it('a classifier retain on an untouched task adds the defaults; later retains keep them; a default family in a list needs no card', () => run('task-defaults-retain', async (sql, scope) => {
  const cap = owned(sql, scope);
  const first = await cap.classify(decision('retain'));
  expect(first.snapshot.sources).toEqual(expect.arrayContaining(['mail', 'calendar']));
  expect(narrowedFlag(sql)).toBe(0);
  const listed = await cap.classify(JSON.stringify({ decision: 'new', sources: ['workspace', 'mail', 'calendar'], evidence: 'plan my trip' }), 'r1', 'plan my trip');
  expect(listed.proposal, 'a default family needs no confirmation card').toBeUndefined();
}));

it('an explicit owner list is exact: restrict, new and change all stay as listed when the defaults later grow', () => run('task-defaults-explicit-exact', async (sql, scope) => {
  for (const [name, raw] of [['restrict', decision('restrict', ['web'])], ['new', JSON.stringify({ decision: 'new', sources: ['web'], evidence: 'plan my trip' })], ['change', JSON.stringify({ decision: 'change', sources: ['web'], evidence: 'plan my trip' })]] as const) {
    sql.exec('DROP TABLE IF EXISTS owner_task_source_scope');
    const before = owned(sql, scope, ['web']);
    await before.classify(decision('retain'));
    await before.classify(raw, 'r1', 'plan my trip');
    expect(narrowedFlag(sql), name).toBe(1);
    const after = owned(sql, scope, ['web', 'mail', 'calendar']);
    expect((await after.classify(decision('retain'))).snapshot.sources, `${name}: Google connected later must not widen an explicit list`).toEqual(['web']);
  }
}));

it('close resets: the next default task has the defaults again', () => run('task-defaults-close', async (sql, scope) => {
  const cap = owned(sql, scope);
  await cap.classify(decision('restrict'));
  expect(narrowedFlag(sql)).toBe(1);
  await cap.classify(JSON.stringify({ decision: 'close', sources: [], evidence: 'plan my trip' }), 'r1', 'plan my trip');
  expect(narrowedFlag(sql)).toBe(0);
  const next = await cap.classify(decision('new', ['workspace']));
  expect(narrowedFlag(sql)).toBe(0);
}));

it('an approved change or new card is an explicit choice (exact, narrowed); an approved close resets', () => run('task-defaults-card', async (sql, scope) => {
  const cap = owned(sql, scope);
  await cap.classify(decision('restrict'));
  const change = await cap.classify(decision('change', ['drive']));
  expect(approveTaskSourceProposal(sql, 'owner-one', change.proposal!, Date.now(), scope)).toBe(true);
  expect(narrowedFlag(sql)).toBe(1);
  expect((await cap.classify(decision('retain'))).snapshot.sources).toEqual(['drive']);
  const fresh = await cap.classify(decision('new', ['drive']));
  expect(approveTaskSourceProposal(sql, 'owner-one', fresh.proposal!, Date.now(), scope)).toBe(true);
  expect(narrowedFlag(sql)).toBe(1);
  expect((await cap.classify(decision('retain'))).snapshot.sources, 'retain after an approved new').toEqual(['drive']);
  const close = await cap.classify(decision('close'));
  expect(approveTaskSourceProposal(sql, 'owner-one', close.proposal!, Date.now(), scope)).toBe(true);
  expect(narrowedFlag(sql)).toBe(0);
}));

it('a confirmed retry that narrows is kept as a narrowing', () => run('task-defaults-retry', async (sql, scope) => {
  const cap = owned(sql, scope);
  sql.exec(`UPDATE owner_task_source_scope SET sources_json = '["workspace","web","mail","calendar"]', ready = 1`);
  const out = await cap.classify(decision('change', ['workspace', 'web']));
  expect(out.outcome).toBe('confirmed_retry');
  expect(narrowedFlag(sql)).toBe(1);
  expect((await cap.classify(decision('retain'))).snapshot.sources).toEqual(['workspace', 'web']);
}));

it('legacy rows: the baseline and the full set take the defaults, any other ready scope stays narrowed', () => run('task-defaults-migrate', async (sql, scope) => {
  for (const [sources, ready, expectNarrowed] of [['["workspace","web"]', 1, 0], [JSON.stringify(TASK_SOURCE_FAMILIES), 1, 0], ['["workspace"]', 1, 1], ['[]', 1, 1], ['["workspace"]', 0, 1]] as const) {
    sql.exec('DROP TABLE IF EXISTS owner_task_source_scope');
    legacyTable(sql, sources, ready);
    owned(sql, scope);
    expect(narrowedFlag(sql), `${sources} ready=${ready}`).toBe(expectNarrowed);
  }
  sql.exec('DROP TABLE IF EXISTS owner_task_source_scope');
  legacyTable(sql, '["workspace"]');
  expect((await owned(sql, scope).classify(decision('retain'))).snapshot.sources, 'an existing restriction is not widened').toEqual(['workspace']);
}));


it('after an explicit narrowing, a change that adds a default back needs the owner card (a new task does not)', () => run('task-defaults-narrowed-card', async (sql, scope) => {
  const cap = owned(sql, scope);
  await cap.classify(decision('retain'));
  await cap.classify(decision('restrict', ['web']));
  expect(narrowedFlag(sql)).toBe(1);
  const change = await cap.classify(JSON.stringify({ decision: 'change', sources: ['web', 'mail'], evidence: 'plan' }), 'r1', 'plan my trip');
  expect(change.proposal, 'adding mail back to a narrowed task needs the card').toBeDefined();
  const fresh = await cap.classify(JSON.stringify({ decision: 'new', sources: ['web', 'mail'], evidence: 'plan' }), 'r1', 'plan my trip');
  expect(fresh.proposal, 'a new task listing a default needs no card').toBeUndefined();
}));

it('a closed run cannot run the narrowed migration (no ALTER or backfill before the fence)', () => run('task-migrate-closed', async (sql, scope) => {
  legacyTable(sql, '["workspace"]');
  const closed: RunEffectScope = { ...scope, admit() { throw new Error('run is closed or expired'); }, commit() { throw new Error('run is closed or expired'); } };
  expect(() => createTaskSourceScope(sql, 'owner-one', closed, async () => {})).toThrow('closed');
  expect(sql.exec<{ name: string }>('PRAGMA table_info(owner_task_source_scope)').toArray().some(column => column.name === 'narrowed')).toBe(false);
  expect(() => approveTaskSourceProposal(sql, 'owner-one', { ownerKey: 'owner-one', taskId: 't1', revision: 1, expiresAt: Date.now() + 1000 } as never, Date.now(), closed)).toThrow('closed');
  expect(sql.exec<{ name: string }>('PRAGMA table_info(owner_task_source_scope)').toArray().some(column => column.name === 'narrowed')).toBe(false);
}));

it('a fresh owner with Google connected gets the read defaults on first retain, including local (memory writes)', () => run('task-fresh-connected', async (sql, scope) => {
  const snapshot = (await owned(sql, scope, ['local', 'workspace', 'web', 'mail', 'calendar', 'contacts', 'tasks', 'drive']).classify(decision('retain'))).snapshot;
  expect(snapshot.ready).toBe(true);
  expect(snapshot.sources).toEqual(expect.arrayContaining(['local', 'workspace', 'web', 'mail', 'calendar']));
  expect(taskSourceAllowed(snapshot, { name: 'search_communication', requires_connector: true })).toBe(true);
  expect(narrowedFlag(sql)).toBe(0);
}));
