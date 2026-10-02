import { buildSessionState, PRIVILEGED_ACTION_TOOLS, TOOL_PERMISSIONS } from '@waldo/contracts';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { workspaceToolHandlers } from '../src/tools/live/workspace';

// Ids carry hex letters: the argument sanitiser redacts all-digit runs shaped like card numbers.
const id = (n: number) => `abcdefab-cdef-4abc-8abc-abcdefab${n.toString(16).padStart(4, '0').replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] === undefined ? d : 'abcdefabcd'[Number(d)]!)}`;
const fresh = async () => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }; const map = new Map<string, Uint8Array>(); let n = 100;
  const store = await workspaceStore({ binding: { ownerId: id(1), environment: 'staging', namespace: 'namespace', doName: 'name', doId: 'id', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }), metadata: { transaction(f) { const draft = structuredClone(state); const r = f(draft); state = draft; return r; } }, bodies: { put: async (b, v) => { map.set(b.blob_id, v); }, get: async (b) => map.get(b.blob_id) ?? null, remove: async (b) => { map.delete(b.blob_id); } }, now: () => 0, newId: () => id(n++) });
  return { store, state: () => state };
};
const context = (trigger: 'user_message' | 'handoff_explore' = 'user_message', withTurn = true) => ({
  authenticatedUserId: 'owner', trigger, ...(withTurn ? { turnId: 'turn-1' } : {}),
  session: buildSessionState({ trigger, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
  hasApproval: () => false, sourceTaint: null, toolArgSourceTaint: null, sanitise,
});
const setup = async () => { const w = await fresh(); const handlers = workspaceToolHandlers(async () => w.store); return { ...w, call: (name: string, args: unknown, callId: string, ctx = context()) => dispatchTool({ id: callId, name: name as never, args }, ctx as never, { handlers }) }; };

describe('workspace tools through the real dispatcher', () => {
  it('write then list then read, with the right taint stamps', async () => {
    const { call, state } = await setup();
    expect(await call('workspace_write', { path: 'notes.md', text: 'hostile instruction is data', mime: 'text/markdown', expected_revision: 0 }, 'w1')).toMatchObject({ ok: true, source_taint: null });
    expect(state().files[0]!.provenance).toBe('agent_generated');
    expect(await call('workspace_list', {}, 'l1')).toMatchObject({ ok: true, source_taint: 'external' });
    const file = state().files[0]!;
    expect(await call('workspace_read', { file_id: file.file_id, revision: 1 }, 'r1')).toMatchObject({ ok: true, source_taint: 'external', data: { text: 'hostile instruction is data' } });
  });

  it('the model cannot supply operation_id; the same call id is idempotent and a new call id is a new operation', async () => {
    const { call, state } = await setup();
    const args = { path: 'a.md', text: 'one', mime: 'text/markdown', expected_revision: 0 };
    expect(await call('workspace_write', { ...args, operation_id: id(9) }, 'w1')).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(state().operations).toHaveLength(0);
    expect(await call('workspace_write', args, 'w1')).toMatchObject({ ok: true });
    expect(await call('workspace_write', args, 'w1')).toMatchObject({ ok: true });
    expect(state().files).toHaveLength(1);
    expect(state().files[0]!.revision).toBe(1);
    expect(state().operations).toHaveLength(1);
    // A different call with the stale expected_revision is a conflict, never a clobber.
    expect(await call('workspace_write', args, 'w2')).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('refuses without a turn identity, and refuses bad mime and oversize before any write', async () => {
    const { call, state } = await setup();
    expect(await call('workspace_write', { path: 'a.md', text: 'x', mime: 'text/markdown', expected_revision: 0 }, 'w1', context('user_message', false))).toMatchObject({ ok: false, code: 'rejected' });
    expect(await call('workspace_write', { path: 'a.pdf', text: 'x', mime: 'application/pdf', expected_revision: 0 }, 'w2')).toMatchObject({ ok: false });
    expect(await call('workspace_write', { path: 'b.md', text: 'x'.repeat(70000), mime: 'text/markdown', expected_revision: 0 }, 'w3')).toMatchObject({ ok: false, code: 'invalid_args' });
    // Multi-byte text is capped in bytes, not characters: 40000 two-byte chars is 80000 bytes.
    expect(await call('workspace_write', { path: 'c.md', text: 'é'.repeat(40000), mime: 'text/markdown', expected_revision: 0 }, 'w4')).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await call('workspace_write', { path: 'd.md', text: 'x'.repeat(65536), mime: 'text/markdown', expected_revision: 0 }, 'w5')).toMatchObject({ ok: true });
    expect(state().files).toHaveLength(1);
  });

  it('all three are user_message only (owner-initiated); no other trigger holds any', () => {
    const grants = (name: string) => Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => (tools as readonly string[]).includes(name)).map(([t]) => t).sort();
    expect(grants('workspace_write')).toEqual(['user_message']);
    expect(grants('workspace_read')).toEqual(['user_message']);
    expect(grants('workspace_list')).toEqual(['user_message']);
    // Decision: workspace_write stays off PRIVILEGED_ACTION_TOOLS, like create_artifact. It writes
    // owner-private storage with compare-and-swap, sends nothing external, and its reads are
    // stamped external. Revisit if a tainted-turn write becomes a real path.
    expect(PRIVILEGED_ACTION_TOOLS).not.toContain('workspace_write');
  });

  it('a write on a trigger that does not hold the tool is refused by the dispatcher', async () => {
    const { call, state } = await setup();
    const out = await call('workspace_write', { path: 'a.md', text: 'x', mime: 'text/markdown', expected_revision: 0 }, 'w1', context('handoff_explore'));
    expect(out).toMatchObject({ ok: false });
    expect(state().files).toHaveLength(0);
  });
});
