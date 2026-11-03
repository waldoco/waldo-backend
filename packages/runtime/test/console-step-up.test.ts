import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { CONSOLE_ACTION_PATH, consoleAccess } from '../src/channels/console';
import { signedInRecently } from '../src/identity/console-auth';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { OWNER_CONTROLS_ACTION_PATH, OWNER_CONTROLS_PATH } from '../src/channels/dashboard-owner-controls';
import * as ownerControls from '../src/channels/dashboard-owner-controls';
import * as controlActions from '../src/channels/dashboard-control-actions';
import * as stepUp from '../src/channels/console-step-up';
import { CONSOLE_ACTIONS, CONSOLE_GOOGLE_START_PATH } from '../src/channels/console';
import { CONSOLE_PHOTON_START_PATH, IMESSAGE_CONSOLE_ACTIONS } from '../src/channels/imessage/console';
import { WHATSAPP_LINK_CONFIRM_ACTION } from '../src/channels/whatsapp-link-console';
import { BROWSER_TRIAL_PATH } from '../src/channels/browser-trial-consent';
import { MCP_START_PATH } from '../src/connectors/mcp-connections';
import { consoleCrossSiteRefusal } from '../src/channels/console-cross-site';
import { APP_PROVIDERS_PATH } from '../src/health/providers/app-providers';
import { appControlActionV1Schema } from '../../contracts/src/app/controls';
import { appChatProviderV1Schema } from '../../contracts/src/app/onboarding';
import { approvalActionV1Schema, approvalKindV1Schema } from '../../contracts/src/app/parts';
import { messagingSurfaceV1Schema } from '../../contracts/src/app/surfaces';

const root = 'https://telegram-owner';
const HOUR = 60 * 60_000;
const directoryEnv = { SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key', WALDO_ROUTER_HMAC_SECRET: 'synthetic-step-up-secret' };
type Read = { csrf: string; revision: string };

afterEach(() => vi.unstubAllGlobals());

// A fictional directory: every RPC is recorded, so a test can tell whether an action's executor ran.
const directory = () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== directoryEnv.SUPABASE_PROJECT_URL) return new Response('unreachable in this test', { status: 502 });
    const name = url.pathname.split('/rpc/')[1] ?? url.pathname;
    calls.push(name);
    if (name === 'list_devices' || name === 'member_invites') return Response.json([]);
    if (name === 'issue_device_pairing_code_owned') return Response.json('41000000-0000-0000-0000-000000000001');
    return Response.json(true);
  }));
  return calls;
};

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, async (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, {
      TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key', ...directoryEnv,
      GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret',
    });
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', root);
    return consoleAccess(state.storage).grant();
  });
  const codeAge = (age: number) => runInDurableObject(stub, async (_instance, state) => {
    const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
    sessions[token] = { ...sessions[token]!, verified_at: Date.now() - age };
    await state.storage.put('console:sessions', sessions);
  });
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
  const read = async (path: string): Promise<Read> => {
    const response = await stub.fetch(root + path, { headers: headers() });
    expect(response.status, path).toBe(200);
    const body = await response.json() as Read & { controls?: Read };
    return body.controls ?? body;
  };
  const post = (path: string, fields: Record<string, string>, extra: Record<string, string> = {}) =>
    stub.fetch(root + path, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded', ...extra }), body: new URLSearchParams(fields) });
  const get = (path: string) => stub.fetch(root + path, { headers: headers({ accept: 'text/html' }) });
  return { stub, token, codeAge, read, post, get };
};

// Each action posts the same request twice, once with a code older than two hours and once with a fresh one. Only deleting the
// account needs the fresh one.
const actions: ReadonlyArray<{ name: string; path: string; read: string; fields: Record<string, string>; ran: (calls: readonly string[], body: Record<string, unknown>) => boolean }> = [
  { name: 'device.pair', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=devices`, fields: { view: 'devices', action: 'device.pair' },
    ran: calls => calls.includes('issue_device_pairing_code_owned') },
  { name: 'google.connect', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'google.connect', value: 'calendar' },
    ran: (_calls, body) => typeof body.receipt === 'object' && body.receipt !== null },
  { name: 'mcp.connect', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'mcp.connect', value: 'https://mcp.example.test/mcp' },
    ran: (_calls, body) => typeof body.receipt === 'object' && body.receipt !== null },
  { name: 'telegram.link', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'telegram.link' },
    ran: calls => calls.includes('issue_link_code') },
  { name: 'whatsapp.link', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'whatsapp.link' },
    ran: calls => calls.includes('issue_provider_link_code') },
  { name: 'invite.member', path: OWNER_CONTROLS_ACTION_PATH, read: `${OWNER_CONTROLS_PATH}?view=invites`, fields: { view: 'invites', action: 'invite.member', value: 'friend@example.test' },
    ran: calls => calls.includes('issue_member_invite') },
  { name: 'account.delete', path: OWNER_CONTROLS_ACTION_PATH, read: `${OWNER_CONTROLS_PATH}?view=account`, fields: { view: 'account', action: 'account.delete', confirmation: 'DELETE' },
    ran: calls => calls.includes('delete_owner') },
];

describe('a fresh email code before an action that creates lasting access', () => {
  for (const action of actions) {
    for (const [age, fresh] of [[3 * HOUR, false], [60_000, true]] as const) {
      const gated = action.name === 'account.delete';
      it(`${action.name} ${fresh ? 'runs with a code from the last two hours' : gated ? 'is refused once the code is over two hours old' : 'runs even when the code is over two hours old'}`, async () => {
        const calls = directory();
        const o = await owner(`step-up-${action.name}-${fresh ? 'fresh' : 'stale'}`);
        await o.codeAge(age);
        const current = await o.read(action.read);
        calls.length = 0;
        const response = await o.post(action.path, { csrf: current.csrf, revision: current.revision, request_id: `step-up-${action.name.replace('.', '-')}-request`, ...action.fields });
        const body = await response.json() as Record<string, unknown>;
        if (fresh || !gated) {
          expect(body.error, action.name).not.toBe('step_up_required');
          expect(action.ran(calls, body), action.name).toBe(true);
        } else {
          expect(response.status, action.name).toBe(403);
          expect(body).toEqual({ error: 'step_up_required' });
          expect(action.ran(calls, body), action.name).toBe(false);
        }
      });
    }
  }

  it('refuses account deletion on the classic console form with an old code, with a way to confirm, and takes the other actions', async () => {
    const calls = directory();
    const o = await owner('step-up-classic');
    await o.codeAge(3 * HOUR);
    for (const fields of [{ action: 'device.pair' }, { action: 'google.connect', value: 'calendar' }, { action: 'invite.create', value: 'friend@example.test' }] as Record<string, string>[]) {
      const page = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', ...fields }, { accept: 'text/html' });
      expect(await page.text(), fields.action).not.toContain('/console/signin?confirm=1');
    }
    calls.length = 0;
    const page = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', action: 'account.delete', value: 'DELETE' }, { accept: 'text/html' });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('/console/signin?confirm=1');
    const json = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', action: 'account.delete', value: 'DELETE' });
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: 'step_up_required' });
    expect(calls).toEqual([]);
  });

  it('leaves ordinary console actions alone when the code is old', async () => {
    directory();
    const o = await owner('step-up-ordinary');
    await o.codeAge(3 * HOUR);
    const current = await o.read(`${CONTROLS_PATH}?view=day`);
    const response = await o.post(CONTROL_ACTION_PATH, { csrf: current.csrf, revision: current.revision, request_id: 'ordinary-pin', view: 'day', action: 'card.pin', id: 'card:close', value: '22:15' });
    expect(response.status).toBe(200);
  });
});

// Every action the console can run, from each registry that accepts one.
const everyAction = (): readonly string[] => {
  const views = (controlActions as Record<string, unknown>).CONTROL_VIEW_ACTIONS as Readonly<Record<string, readonly string[]>> | undefined;
  const owner = (ownerControls as Record<string, unknown>).OWNER_CONTROL_VIEW_ACTIONS as Readonly<Record<string, string>> | undefined;
  expect(views, 'the controls registry is exported').toBeDefined();
  expect(owner, 'the owner controls registry is exported').toBeDefined();
  const app = appControlActionV1Schema.shape.action.options.flatMap(action => (action === 'channel.unlink' ? messagingSurfaceV1Schema.options : [undefined]).map(id => stepUp.appControlStepUpAction({ action, id })));
  return [...new Set([...CONSOLE_ACTIONS, ...IMESSAGE_CONSOLE_ACTIONS, WHATSAPP_LINK_CONFIRM_ACTION, ...Object.values(views ?? {}).flat(), ...Object.values(owner ?? {}), ...app])].sort();
};
const table = () => ((stepUp as Record<string, unknown>).STEP_UP_ACTIONS ?? {}) as Readonly<Record<string, Readonly<{ gated: unknown; why: unknown }>>>;
const routes = () => ((stepUp as Record<string, unknown>).STEP_UP_ROUTES ?? {}) as Readonly<Record<string, Readonly<{ gated: unknown; why: unknown; startsFlow?: unknown }>>>;
const GATED = ['account.delete'];
const oneLine = (why: unknown) => typeof why === 'string' && why.length > 0 && why.length <= 160 && !why.includes('\n');

describe('every console action is classified before it ships', () => {
  it('names each action every registry accepts, and nothing else, with a one-line reason', () => {
    const classified = table();
    expect(Object.keys(classified).sort()).toEqual(everyAction());
    for (const [action, rule] of Object.entries(classified)) {
      expect(typeof rule.gated, action).toBe('boolean');
      expect(oneLine(rule.why), action).toBe(true);
    }
  });

  it('needs a fresh code for exactly the actions that cannot be undone', () => {
    expect(Object.entries(table()).filter(([, rule]) => rule.gated === true).map(([action]) => action).sort()).toEqual(GATED);
  });

  it('gates an action the table does not name', () => {
    expect(stepUp.stepUpGated('account.delete')).toBe(true);
    expect(stepUp.stepUpGated('google.connect')).toBe(false);
    expect(stepUp.stepUpGated('unlisted.action')).toBe(true);
  });

  it('classifies the console routes that start access or consent outside an action, and gates none', () => {
    const classified = routes();
    expect(classified[CONSOLE_PHOTON_START_PATH]).toBeDefined();
    for (const [path, rule] of Object.entries(classified)) {
      expect([path, rule.gated]).toEqual([path, false]);
      expect(typeof rule.gated, path).toBe('boolean');
      expect(typeof rule.startsFlow, path).toBe('boolean');
      expect(oneLine(rule.why), path).toBe(true);
    }
  });

  // One list: the cross-site guard refuses a GET another site sends exactly where this table says the GET begins a flow.
  it('refuses a GET another site sends on exactly the routes the table marks as starting a flow', () => {
    const flows = Object.entries(routes()).filter(([, rule]) => rule.startsFlow === true).map(([path]) => path).sort();
    expect(flows).toEqual([BROWSER_TRIAL_PATH, CONSOLE_GOOGLE_START_PATH, CONSOLE_PHOTON_START_PATH, MCP_START_PATH].sort());
    const sample = (path: string) => path.endsWith('/') ? `${path}${'n'.repeat(43)}` : path;
    for (const path of [...Object.keys(routes()), '/console', '/console/devices', '/console/imessage', `${CONTROLS_PATH}?view=day`]) {
      const refused = consoleCrossSiteRefusal(new Request(`https://w.test${sample(path)}`, { headers: { 'sec-fetch-site': 'cross-site' } }));
      expect([path, refused?.status ?? null]).toEqual([path, flows.includes(path) ? 403 : null]);
    }
    // A prefix needs a token after it; an exact path does not match as a prefix.
    for (const path of [MCP_START_PATH, CONSOLE_GOOGLE_START_PATH, `${CONSOLE_PHOTON_START_PATH}/more`, `${BROWSER_TRIAL_PATH}-more`]) {
      expect(consoleCrossSiteRefusal(new Request(`https://w.test${path}`, { headers: { 'sec-fetch-site': 'cross-site' } })), path).toBeNull();
    }
  });
});

// Linking a chat number, pairing a Mac and letting a tool run once needed a code from the last two hours; by owner ruling
// (beta) a signed-in session does each without one.
const IMESSAGE_FIELDS: Readonly<Record<string, Record<string, string>>> = {
  'imessage.enroll': { phone: '+15555550100' }, 'imessage.link': {}, 'imessage.pair': {}, 'imessage.pair_shared': {},
  'imessage.verify': { id: `imb_${'a'.repeat(32)}`, subject: 'owner@example.test', chat: 'iMessage;-;owner@example.test' },
  'imessage.activate': { id: `imb_${'a'.repeat(32)}`, subject: 'owner@example.test', chat: 'iMessage;-;owner@example.test' },
  'imessage.activate_shared': { id: `imb_${'a'.repeat(32)}`, subject: 'owner@example.test', chat: 'iMessage;-;owner@example.test' },
};
const WHATSAPP_TOKEN = 'w'.repeat(43);
const controlsRequests = [
  ...['telegram.link', 'whatsapp.link'].map(action => ({ action, fields: { view: 'connections', action } })),
  { action: 'mcp.runs', fields: { view: 'connections', action: 'mcp.runs', id: 'mcp-server-1', value: 'search:on' } },
  ...Object.entries(IMESSAGE_FIELDS).map(([action, fields]) => ({ action, fields: { view: 'imessage', action, ...fields } })),
];
const classicRequests = [
  ...Object.entries(IMESSAGE_FIELDS).map(([action, fields]) => ({ action, fields: { action, ...fields } })),
  { action: 'telegram.link', fields: { action: 'telegram.link' } },
  { action: WHATSAPP_LINK_CONFIRM_ACTION, fields: { action: WHATSAPP_LINK_CONFIRM_ACTION, token: WHATSAPP_TOKEN, subject: '15555550100' } },
];

describe('linking a chat, pairing a Mac and letting a tool run need no fresh code', () => {
  for (const [age, fresh] of [[3 * HOUR, false], [60_000, true]] as const) {
    it(`the dashboard's ${fresh ? 'fresh' : 'old'} code passes the check`, async () => {
      directory();
      const o = await owner(`step-up-dashboard-${fresh ? 'fresh' : 'stale'}`);
      await o.codeAge(age);
      for (const request of controlsRequests) {
        const response = await o.post(CONTROL_ACTION_PATH, { csrf: 'c'.repeat(64), revision: 'r'.repeat(64), request_id: `step-up-${request.action.replace('.', '-')}`, ...request.fields });
        const body = await response.json() as Record<string, unknown>;
        expect(body.error, request.action).not.toBe('step_up_required');
      }
    });

    it(`the classic console's ${fresh ? 'fresh' : 'old'} code passes the check`, async () => {
      directory();
      const o = await owner(`step-up-classic-chat-${fresh ? 'fresh' : 'stale'}`);
      await o.codeAge(age);
      for (const request of classicRequests) {
        const page = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', ...request.fields }, { accept: 'text/html' });
        expect(await page.text(), request.action).not.toContain('/console/signin?confirm=1');
      }
    });

    it(`starting a Photon connect passes the check with a${fresh ? ' fresh' : 'n old'} code`, async () => {
      directory();
      const o = await owner(`step-up-photon-${fresh ? 'fresh' : 'stale'}`);
      await o.codeAge(age);
      const response = await o.get(CONSOLE_PHOTON_START_PATH);
      expect(await response.text()).not.toContain('/console/signin?confirm=1');
    });
  }

  it('the confirm page for account deletion links to the email-code sign-in', async () => {
    directory();
    const o = await owner('step-up-return');
    await o.codeAge(3 * HOUR);
    const deletion = await (await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', action: 'account.delete', value: 'DELETE' }, { accept: 'text/html' })).text();
    expect(deletion).toContain('href="/console/signin?confirm=1"');
  });
});

describe('a session a sign-in replaced in this browser', () => {
  it('keeps ordinary actions while it runs out, but cannot delete the account even though its code was fresh', async () => {
    const calls = directory();
    const o = await owner('step-up-replaced');
    await o.codeAge(60_000);
    await runInDurableObject(o.stub, async (_instance, state) => { await consoleAccess(state.storage).grant(o.token); });
    const day = await o.read(`${CONTROLS_PATH}?view=day`);
    const pin = await o.post(CONTROL_ACTION_PATH, { csrf: day.csrf, revision: day.revision, request_id: 'replaced-pin', view: 'day', action: 'card.pin', id: 'card:close', value: '22:15' });
    expect(pin.status).toBe(200);
    const devices = await o.read(`${CONTROLS_PATH}?view=devices`);
    calls.length = 0;
    const pair = await o.post(CONTROL_ACTION_PATH, { csrf: devices.csrf, revision: devices.revision, request_id: 'replaced-pair', view: 'devices', action: 'device.pair' });
    expect((await pair.json() as Record<string, unknown>).error).not.toBe('step_up_required');
    expect(calls).toContain('issue_device_pairing_code_owned');
    const account = await o.read(`${OWNER_CONTROLS_PATH}?view=account`);
    calls.length = 0;
    const remove = await o.post(OWNER_CONTROLS_ACTION_PATH, { csrf: account.csrf, revision: account.revision, request_id: 'replaced-delete', view: 'account', action: 'account.delete', confirmation: 'DELETE' });
    expect(remove.status).toBe(403);
    expect(await remove.json()).toEqual({ error: 'step_up_required' });
    expect(calls).not.toContain('delete_owner');
  });
});

// The app reaches the same things through its own routes, so each app request is named by the console action it is, and one
// table decides both surfaces. A new app action or approval kind fails here until the table names it.
describe('every app action and approval decision is classified by the same table', () => {
  it('names each app control, for each channel it can unlink, by a console action the table classifies', () => {
    for (const action of appControlActionV1Schema.shape.action.options) {
      for (const id of action === 'channel.unlink' ? messagingSurfaceV1Schema.options : [undefined]) {
        const named = stepUp.appControlStepUpAction({ action, id });
        expect([action, id, named in table()]).toEqual([action, id, true]);
      }
    }
    expect(stepUp.appControlStepUpAction({ action: 'google.connect' })).toBe('google.connect');
    expect(stepUp.appControlStepUpAction({ action: 'account.delete' })).toBe('account.delete');
    for (const action of ['claim.pin', 'claim.unpin', 'claim.edit']) expect(stepUp.appControlStepUpAction({ action })).toBe(action);
  });

  it('names each chat channel the app can link by its console link action, which needs no fresh code', () => {
    for (const provider of appChatProviderV1Schema.options) {
      const named = stepUp.appLinkStepUpAction(provider);
      expect([provider, table()[named]?.gated]).toEqual([provider, false]);
    }
  });

  it('classifies every approval kind, and a calendar change that reaches other people, with a one-line reason', () => {
    const classified = stepUp.STEP_UP_APPROVALS as Readonly<Record<string, Readonly<{ gated: unknown; why: unknown }>>>;
    expect(Object.keys(classified).sort()).toEqual([...approvalKindV1Schema.options, 'calendar_shared'].sort());
    for (const [kind, rule] of Object.entries(classified)) {
      expect(typeof rule.gated, kind).toBe('boolean');
      expect(oneLine(rule.why), kind).toBe(true);
    }
    expect(Object.entries(classified).filter(([, rule]) => rule.gated === true).map(([kind]) => kind).sort())
      .toEqual(['agent_mail_send', 'browser_submit', 'calendar_shared', 'email_send', 'mcp_call', 'message_send', 'tainted_action']);
  });

  it('gates only approving, and approving a send whatever else it carries', () => {
    const exact = { recipients: { to: ['someone@example.test'], cc: [], bcc: [] } };
    for (const kind of approvalKindV1Schema.options) {
      for (const action of approvalActionV1Schema.options) {
        const gated = stepUp.appApprovalStepUp({ kind, exact }, action);
        expect([kind, action, gated]).toEqual([kind, action, action === 'approve' && kind !== 'calendar_change' && kind !== 'google_task_change']);
      }
    }
  });

  it('gates approving a kind the table does not name', () => {
    expect(stepUp.appApprovalStepUp({ kind: 'unlisted_kind' as never, exact: {} }, 'approve')).toBe(true);
    expect(stepUp.appApprovalStepUp({ kind: 'unlisted_kind' as never, exact: {} }, 'skip')).toBe(false);
  });

  it('keeps a hold on the owner\'s own primary calendar one tap, and gates one with guests or on another calendar', () => {
    const hold = { action: 'create', title: 'Focus', start: '2030-01-02T15:00:00Z', end: '2030-01-02T16:00:00Z' } as const;
    const decide = (changes: Record<string, unknown>) => stepUp.appApprovalStepUp({ kind: 'calendar_change', exact: { changes: { ...hold, ...changes } } }, 'approve');
    expect(decide({})).toBe(false);
    expect(decide({ location: 'Home' })).toBe(false);
    expect(decide({ guests: ['guest@example.test'] })).toBe(true);
    expect(decide({ emails_guests: false })).toBe(true);
    expect(decide({ calendar: 'team@group.calendar.google.com' })).toBe(true);
  });

  it('classifies the app routes with no console action of their own', () => {
    expect(stepUp.APP_STEP_UP_ROUTES[`${APP_PROVIDERS_PATH}/connect`]?.gated).toBe(false);
    for (const [path, rule] of Object.entries(stepUp.APP_STEP_UP_ROUTES)) expect([path, rule.gated, oneLine(rule.why)]).toEqual([path, false, true]);
  });

  it('counts an app session as recent proof for two hours after it signs in, and an unreadable sign-in time as none', () => {
    const now = Date.parse('2030-01-02T12:00:00Z');
    expect(signedInRecently(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(signedInRecently(new Date(now - 2 * HOUR).toISOString(), now)).toBe(false);
    expect(signedInRecently(new Date(now - 3 * HOUR).toISOString(), now)).toBe(false);
    expect(signedInRecently(undefined, now)).toBe(false);
    expect(signedInRecently('not a time', now)).toBe(false);
  });
});
