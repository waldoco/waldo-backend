import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { RunLoopDO } from '../src/run-loop/do';
import { AppInbox } from '../src/channels/app-inbox';
import { routerSignature } from '../src/identity/owner-directory';

it('actual app-only Work serving reads the signed canonical source and pauses only its exact queued inbox envelope', async () => {
  const owner = '10000000-0000-0000-0000-000000000001', auth = '20000000-0000-0000-0000-000000000001', session = 'a'.repeat(64);
  const secret = 'fictional-owner-work-serving-secret-00000000000', directory = 'https://owner-work-serving.fixture.invalid';
  const name = `owner-work-serving-${crypto.randomUUID()}`, ownerStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(ownerStub, async (_, state) => {
    let live = true, sourceLive = true, sourceReads = 0; const expires = Date.now() + 3600000;
    const errors: string[] = []; const calls: string[] = [], principal = `prn_${owner.replaceAll('-', '')}`;
    const settings = { ...env, COMMON_OWNER_TASKS: '0', TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined,
      OPENAI_API_KEY: 'synthetic-model-key', WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE: 'fixture-work-serving', WALDO_OWNER_TIMEZONE: 'UTC',
      SUPABASE_PROJECT_URL: directory, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: secret,
      RUN_LOOP_DO: { idFromName: (rootName: string) => env.RUN_LOOP_DO.idFromName(rootName), get: (id: DurableObjectId) => ({
        readOwnerWorkProjectionFromHost: async (request: Parameters<RunLoopDO['readOwnerWorkProjectionFromHost']>[0]) => {
          if (!sourceLive) throw Error('canonical source unavailable'); sourceReads++;
          try { return await runInDurableObject(env.RUN_LOOP_DO.get(id), async (_root, rootState) => new RunLoopDO(rootState, settings).readOwnerWorkProjectionFromHost(request)); } catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
        },
      }) } as never } as Cloudflare.Env & { COMMON_OWNER_TASKS: string };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); if (url.origin !== directory || !url.pathname.startsWith('/rest/v1/rpc/')) throw Error('unlisted network forbidden');
      const fn = url.pathname.split('/').at(-1)!, args = JSON.parse(String(init?.body)); calls.push(fn);
      if (fn === 'console_session_list') { expect(args.p_sig).toBe(await routerSignature(secret, args.p_at, `consolesess.list.${args.p_do_name}`)); return Response.json(live && args.p_do_name === name ? [{ session, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }] : []); }
      if (fn === 'app_session_authority') { expect(args.p_sig).toBe(await routerSignature(secret, args.p_at, `app.session.${args.p_do_name}.${args.p_session_hash}`)); return Response.json(live && args.p_do_name === name && args.p_session_hash === session ? { owner_id: owner, do_name: name, session_hash: session, state_version: 0, admission_revision: '1', expires_at: expires } : null); }
      if (fn === 'owner_runtime_authority') { expect(args.p_sig).toBe(await routerSignature(secret, args.p_at, `owner.runtime.${args.p_do_name}`)); return Response.json(args.p_do_name === name ? { owner_id: owner, auth_user_id: auth, do_name: name, state_version: 0, admission_revision: '1' } : null); }
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: owner, environment: 'staging', namespace: 'fixture-work-serving', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_context_read' || fn === 'health_plane') return Response.json(null);
      throw Error(`unlisted signed directory RPC ${fn}`);
    });
    state.storage.kv.put('do_name', name); state.storage.kv.put('origin', 'https://local.invalid');
    const instance = new TelegramOwnerDO(state, settings), inbox = new AppInbox(state.storage);
    const originalAppRequest = (instance as any).appRequest.bind(instance); vi.spyOn(instance as any, 'appRequest').mockImplementation(async (...args: unknown[]) => { try { return await originalAppRequest(...args); } catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; } });
    const queued = await inbox.admit(name, session, 'actual_queued_owner_B', 'Exact admitted request B', { conversationRef: `owner:${principal}` });
    const sibling = await inbox.admit(name, session, 'actual_unrelated_owner_C', 'Separate request C', { conversationRef: `owner:${principal}` });
    if (queued.kind !== 'admitted' || sibling.kind !== 'admitted') throw Error('admission');
    const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': session, 'content-type': 'application/json' };
    try {
      expect(settings.TELEGRAM_BOT_TOKEN).toBeUndefined(); expect(state.storage.kv.get('telegram_subject')).toBeUndefined();
      const response = await instance.fetch(new Request('https://local.invalid/app/v1/work', { headers })); expect(response.status, JSON.stringify({ body: await response.clone().json(), calls, sourceReads, errors })).toBe(200);
      const shown = await response.json() as any, task = shown.tasks.find((row: any) => row.work_ref === `run:${queued.record.id}`);
      expect(shown.counts).toMatchObject({ scope: 'retained_owner_records', total: 2, by_kind: { responsibility: 0, work_unit: 0, run: 2 } });
      expect(task).toMatchObject({ status: 'admitted', controls: { state: 'active', allowed: ['pause', 'stop', 'reconcile'] } });
      const intent = { operation_id: 'actual_native_pause_B', work_ref: task.work_ref, action: 'pause', expected_revision: task.controls.revision,
        expected_source_revision: shown.source_revision, projection_revision: shown.revision };
      const paused = await instance.fetch(new Request('https://local.invalid/app/v1/work/operations', { method: 'POST', headers, body: JSON.stringify(intent) }));
      expect(paused.status).toBe(200); expect(await paused.json()).toMatchObject({ receipt: { state: 'recorded', cancellation: 'fenced' } });
      expect(inbox.records().find(row => row.id === queued.record.id)).toMatchObject({ state: 'interrupted', text: 'Exact admitted request B' });
      expect(inbox.records().find(row => row.id === sibling.record.id)?.state).toBe('admitted'); expect(sourceReads).toBeGreaterThan(0);
      sourceLive = false; expect((await instance.fetch(new Request('https://local.invalid/app/v1/work', { headers }))).status).toBe(503);
      sourceLive = true; live = false; expect((await instance.fetch(new Request('https://local.invalid/app/v1/work', { headers }))).status).toBe(401);
      expect(calls).toContain('owner_runtime_authority'); expect(calls).not.toContain('common_owner_authority');
    } finally { await state.storage.deleteAlarm(); fetcher.mockRestore(); }
  });
}, 30000);
