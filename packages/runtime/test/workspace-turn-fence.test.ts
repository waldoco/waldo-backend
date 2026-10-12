import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { buildSessionState } from '@waldo/contracts';
import { workspaceMetadata, workspaceOwnerHost } from '../src/channels/workspace-host';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool } from '../src/tools/dispatcher';
import { workspaceToolHandlers } from '../src/tools/live/workspace';

// Host seam regression; the synthetic open interface does not prove DO registration.
it.each(['mapping', 'body'] as const)('closed owner run cannot publish a workspace revision after its %s await', async phase => {
  const doName = `workspace-fence-gap-${crypto.randomUUID()}`;
  const id = env.TELEGRAM_OWNER_DO!.idFromName(doName);
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(id), async (_instance, state) => {
    let live = true;
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const bytes = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, body: Uint8Array) => { if (phase === 'body') { entered(); await wait; } bytes.set(key, body.slice()); },
      get: async (key: string) => { const body = bytes.get(key); return body ? { arrayBuffer: async () => body.slice().buffer } : null; },
      delete: async (key: string) => { bytes.delete(key); },
    } as unknown as R2Bucket;
    const binding = { owner_id: 'abcdefab-cdef-4abc-8abc-abcdefabcdef', environment: 'test', namespace: 'workspace-fence-fixture', do_name: doName, do_id: id.toString(), state_version: 0, mapping_version: 1 };
    const privateEnv = { ...env, SUPABASE_PROJECT_URL: 'https://db.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture', WALDO_ROUTER_HMAC_SECRET: 'fictional-router', WALDO_ENVIRONMENT: 'test', WALDO_OWNER_DO_NAMESPACE: binding.namespace, ARTIFACTS: bucket };
    let firstMapping = true;
    const fetcher = vi.fn(async () => {
      if (phase === 'mapping' && firstMapping) { firstMapping = false; entered(); await wait; }
      return Response.json(binding);
    });
    const scope = { runId: 'fixture-run', attempt: 'fixture-attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal,
      admit() { if (!live) throw new ClosedRunError(); },
      commit<T>(work: () => T) { return state.storage.transactionSync(() => { this.admit(); return work(); }); },
    };
    const open = () => workspaceOwnerHost(privateEnv, state.storage, id.toString(), doName, fetcher, scope);
    const trigger = 'user_message' as const;
    const context = { authenticatedUserId: 'owner', turnId: 'fixture-turn', trigger, runScope: scope,
      session: buildSessionState({ trigger, canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }),
      hasApproval: () => false, sourceTaint: null, toolArgSourceTaint: null, sanitise,
    };
    const pending = dispatchTool({ id: 'write-call', name: 'workspace_write', args: { path: 'late.md', text: 'late bytes', mime: 'text/markdown', expected_revision: 0 } }, context, { handlers: workspaceToolHandlers(open) });
    const caught = pending.catch(error => error);
    await reached;
    live = false;
    release();
    const result = await caught;
    expect(result instanceof ClosedRunError || result?.ok === false).toBe(true);
    const retained = workspaceMetadata(state.storage).transaction(s => structuredClone(s));
    expect(retained.files).toEqual([]);
    if (phase === 'mapping') {
      expect(bytes.size).toBe(0);
      expect(retained.operations).toEqual([]);
      expect(retained.binding).toBeNull();
    } else {
      expect(bytes.size).toBe(1);
      expect(retained.operations).toHaveLength(1);
      expect(retained.operations[0]?.status).toBe('pending');
      expect(new TextDecoder().decode([...bytes.values()][0])).toBe('late bytes');
      expect(retained.bodies).toEqual([]);
    }
  });
});

it('scoped metadata checks closure inside the atomic commit and rolls back failed work', async () => {
  const id = env.TELEGRAM_OWNER_DO!.idFromName(`workspace-metadata-fence-${crypto.randomUUID()}`);
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(id), async (_instance, state) => {
    let live = true;
    const scope = { runId: 'metadata-run', attempt: 'metadata-attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal,
      admit() { if (!live) throw new ClosedRunError(); },
      commit<T>(work: () => T) { return state.storage.transactionSync(() => { this.admit(); return work(); }); },
    };
    const metadata = workspaceMetadata(state.storage, scope);
    const binding = { ownerId: 'abcdefab-cdef-4abc-8abc-abcdefabcdef', environment: 'test', namespace: 'metadata-fixture', doName: 'metadata-owner', doId: id.toString(), stateVersion: 0, mappingVersion: 1 };
    metadata.transaction(s => { s.binding = binding; });
    expect(() => metadata.transaction(s => { s.binding = null; throw new Error('rollback'); })).toThrow('rollback');
    expect(metadata.transaction(s => s.binding)).toEqual(binding);
    live = false;
    expect(() => metadata.transaction(s => { s.binding = null; })).toThrow(ClosedRunError);
    expect(workspaceMetadata(state.storage).transaction(s => s.binding)).toEqual(binding);
  });
});
