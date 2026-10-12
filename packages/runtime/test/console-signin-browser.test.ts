// Engine-neutral DOM/event fixture for the script emitted by the real handler.
// Native Chrome checks supplement these contracts; no provider is contacted.
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const browser = async (target = '') => {
  const response = await handleConsole(new Request('https://fixture.test/console/signin'),
    { TELEGRAM_OWNER_DO: {} as DurableObjectNamespace }, {} as ConsoleAuth);
  const script = (await response!.text()).match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const events: Record<string, (event?: any) => Promise<void> | void> = {};
  const history: unknown[] = [];
  const navigations: string[] = [];
  const requests: { url: string; options: RequestInit; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const makeMain = (phase = 'details') => {
    const fields = { ...(target ? { return_to: target } : {}), email: 'fixture@example.test', phone: '+15555550123', invite: 'FIXTURE', ...(phase === 'code' ? { code: 'synthetic-otp' } : {}) };
    const inputs = Object.entries(fields).map(([name, value]) => ({ name, value, focus: () => {} }));
    const attributes = new Map<string, string>();
    const form = { action: `https://fixture.test/console/${phase === 'code' ? 'verify' : 'signin'}`, method: 'post', dataset: { pending: 'Working…' },
      inputs, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) };
    const button = { disabled: false };
    const cancel = { hidden: true, disabled: false, addEventListener: (name: string, handler: () => void) => { events[`cancel-${name}`] = handler; } };
    const status = { textContent: '' };
    const download = { getAttribute: (name: string) => name === 'href' ? inputs.find(input => input.name === 'return_to')?.value : null };
    const main: any = { phase, form, button, cancel, status, inputs, attributes,
      querySelector: (selector: string) => selector === '#signin-download' ? phase === 'download' ? download : null : selector === 'input:not([type="hidden"])' ? inputs[0] : selector === '#signin-code' ? inputs.find(input => input.name === 'code') ?? null : selector === '#signin-progress' ? status : selector === '#signin-cancel' ? cancel : null,
      querySelectorAll: (selector: string) => selector === 'form' ? phase === 'download' ? [] : [form] : selector === 'button' ? [button, cancel] : selector === 'input' ? inputs : [],
      cloneNode: () => { const clone = makeMain(phase); inputs.forEach(input => { clone.inputs.find((other: any) => other.name === input.name).value = input.value; }); return clone; },
      replaceWith: (next: any) => { current = next; },
    };
    return main;
  };
  let current = makeMain();
  const listen = (name: string, handler: any) => { events[name] = handler; };
  const location = { href: 'https://fixture.test/console/signin', origin: 'https://fixture.test', assign: (url: string) => navigations.push(url) };
  runInNewContext(script, {
    URL, URLSearchParams, AbortController,
    FormData: class { constructor(private form: any) {} *entries() { for (const input of this.form.inputs) yield [input.name, input.value]; } [Symbol.iterator]() { return this.entries(); } },
    DOMParser: class { parseFromString(text: string) {
      const { phase, values } = text.startsWith('{') ? JSON.parse(text) : { phase: text, values: {} };
      const main = makeMain(phase);
      main.inputs.forEach((input: any) => { if (input.name === 'code') input.value = ''; else if (values[input.name]) input.value = values[input.name]; });
      return { querySelector: () => phase === 'malformed' ? null : main };
    } },
    fetch: (url: string, options: RequestInit) => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); }),
    history: { replaceState: (state: unknown) => { history[0] = state; }, pushState: (state: unknown) => history.push(state) },
    location,
    document: { querySelector: () => current, getElementById: (id: string) => current.querySelector(`#${id}`), querySelectorAll: (selector: string) => current.querySelectorAll(selector), addEventListener: listen, importNode: (main: any) => main.cloneNode(true) },
    window: { addEventListener: listen },
  });
  const submit = () => { let prevented = false; const settled = events.submit!({ target: current.form, preventDefault: () => { prevented = true; } }); return { prevented, settled }; };
  const reply = (index: number, phase: string, overrides = {}) => requests[index]!.resolve({ ok: true, redirected: false, url: requests[index]!.url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => phase, ...overrides });
  return { events, requests, history, navigations, submit, reply, ui: () => current };
};

describe('sign-in async navigation', () => {
  it('submits once without POST document navigation and keeps only a phase in history', async () => {
    const browserUi = await browser();
    const first = browserUi.submit();
    expect(first.prevented).toBe(true);
    browserUi.submit();
    expect(browserUi.requests).toHaveLength(1);
    expect(browserUi.ui().button.disabled).toBe(true);
    browserUi.reply(0, 'code');
    await first.settled;
    expect(browserUi.ui().phase).toBe('code');
    expect(browserUi.history).toEqual([{ waldoSignin: 'details' }, { waldoSignin: 'code' }]);
    expect(browserUi.navigations).toEqual([]);
    expect(browserUi.requests[0]!.options).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'follow' });
  });
});

it('clears OTP before transport and never posts on Back or Forward', async () => {
  const b = await browser();
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  b.ui().inputs.find((input: any) => input.name === 'code').value = 'one-use-fixture';
  const verify = b.submit();
  expect(b.ui().inputs.find((input: any) => input.name === 'code').value).toBe('');
  expect(String(b.requests[1]!.options.body)).toContain('code=one-use-fixture');
  b.reply(1, 'code'); await verify.settled;
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  expect(b.ui().phase).toBe('details');
  expect(b.ui().inputs.find((input: any) => input.name === 'email').value).toBe('fixture@example.test');
  await b.events.popstate!({ state: { waldoSignin: 'code' } });
  expect(b.ui().phase).toBe('code');
  expect(b.ui().inputs.find((input: any) => input.name === 'code').value).toBe('');
  expect(b.requests).toHaveLength(2);
  expect(JSON.stringify(b.history)).not.toContain('fixture');
});

it('ignores a cancelled result and late redirect, including after a new attempt', async () => {
  const b = await browser();
  const first = b.submit();
  await b.events.click!({ target: { closest: () => true } });
  expect(b.requests[0]!.options.signal!.aborted).toBe(true);
  expect(b.ui().button.disabled).toBe(false);
  expect(b.ui().status.textContent).toContain('may have completed');
  const second = b.submit();
  b.reply(0, 'code', { redirected: true, url: 'https://fixture.test/console' });
  await first.settled;
  expect(b.ui().button.disabled).toBe(true);
  expect(b.ui().phase).toBe('details');
  expect(b.navigations).toEqual([]);
  b.reply(1, 'code'); await second.settled;
  expect(b.ui().phase).toBe('code');
});

it('aborts on navigation and restoration, without replaying a request', async () => {
  const b = await browser();
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit();
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  expect(b.requests[1]!.options.signal!.aborted).toBe(true);
  b.reply(1, 'code', { redirected: true, url: 'https://fixture.test/console' });
  await verify.settled;
  expect(b.ui().phase).toBe('details');
  expect(b.navigations).toEqual([]);
  await b.events.pagehide!(); await b.events.pageshow!();
  expect(b.requests).toHaveLength(2);
  expect(b.ui().button.disabled).toBe(false);
});

it.each([
  { redirected: true, url: 'https://outside.test/console' },
  { redirected: true, url: 'https://fixture.test/console?next=secret' },
  { redirected: true, url: 'https://fixture.test/console#secret' },
  { redirected: true, url: 'https://fixture.test/console/signin' },
  { redirected: true, url: 'https://fixture.test/console', ok: false },
  { url: 'https://outside.test/console/verify' },
  { headers: new Headers({ 'content-type': 'application/json' }) },
  { ok: false },
])('recovers from an unexpected response without redirect or retry: %j', async overrides => {
  const b = await browser();
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); b.reply(1, 'code', overrides); await verify.settled;
  expect(b.navigations).toEqual([]);
  expect(b.ui().phase).toBe('code');
  expect(b.ui().button.disabled).toBe(false);
  expect(b.ui().status.textContent).toContain('may have completed');
  expect(b.requests).toHaveLength(2);
});

it('navigates only for the existing successful verification redirect', async () => {
  const b = await browser();
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); b.reply(1, 'code', { redirected: true, url: 'https://fixture.test/console' }); await verify.settled;
  expect(b.navigations).toEqual(['/console']);
});

it('handles a fetch/CSP failure with preserved details and no automatic native retry', async () => {
  const b = await browser(); const send = b.submit();
  b.requests[0]!.reject(new TypeError('Failed to fetch')); await send.settled;
  expect(b.ui().button.disabled).toBe(false);
  expect(b.ui().inputs.find((input: any) => input.name === 'email').value).toBe('fixture@example.test');
  expect(b.ui().status.textContent).toContain('may have completed');
  expect(b.requests).toHaveLength(1);
});

it('preserves the current form when response HTML is not a retry form', async () => {
  const b = await browser(); const send = b.submit(); b.reply(0, 'malformed'); await send.settled;
  expect(b.ui().phase).toBe('details'); expect(b.ui().button.disabled).toBe(false);
  expect(b.ui().status.textContent).toContain('may have completed'); expect(b.requests).toHaveLength(1);
});

it('does not move an outstanding code to unsent details edited after Back', async () => {
  const b = await browser(); const send = b.submit(); b.reply(0, 'code'); await send.settled;
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  b.ui().inputs.forEach((input: any) => { input.value = input.name === 'email' ? 'other@example.test' : input.name === 'phone' ? '+15555550999' : 'OTHER'; });
  await b.events.popstate!({ state: { waldoSignin: 'code' } });
  expect(b.ui().inputs.find((input: any) => input.name === 'email').value).toBe('fixture@example.test');
  expect(b.ui().inputs.find((input: any) => input.name === 'phone').value).toBe('+15555550123');
  expect(b.ui().inputs.find((input: any) => input.name === 'invite').value).toBe('FIXTURE');
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  expect(b.ui().inputs.find((input: any) => input.name === 'email').value).toBe('other@example.test');
  expect(b.requests).toHaveLength(1);
});

it('keeps an uncertain outcome visible after Back interrupts a request and after restoration', async () => {
  const b = await browser(); const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); await b.events.popstate!({ state: { waldoSignin: 'details' } });
  expect(b.ui().status.textContent).toContain('may have completed');
  await b.events.pagehide!(); await b.events.pageshow!();
  expect(b.ui().status.textContent).toContain('may have completed');
  b.reply(1, 'code'); await verify.settled;
  expect(b.ui().status.textContent).toContain('may have completed');
});

it('establishes a new code recipient only after an explicit new request response', async () => {
  const b = await browser(); const first = b.submit(); b.reply(0, 'code'); await first.settled;
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  b.ui().inputs.find((input: any) => input.name === 'email').value = 'other@example.test';
  const next = b.submit();
  expect(String(b.requests[1]!.options.body)).toContain('email=other%40example.test');
  b.reply(1, JSON.stringify({ phase: 'code', values: { email: 'other@example.test' } })); await next.settled;
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  await b.events.popstate!({ state: { waldoSignin: 'code' } });
  expect(b.ui().inputs.find((input: any) => input.name === 'email').value).toBe('other@example.test');
  expect(b.requests).toHaveLength(2);
});

it('ignores stale HTML decoding after cancellation', async () => {
  const b = await browser(); let finish!: (value: string) => void; let started!: () => void;
  const decoding = new Promise<void>(resolve => { started = resolve; });
  const send = b.submit(); b.reply(0, 'code', { text: () => new Promise(resolve => { finish = resolve; started(); }) });
  await decoding; await b.events.click!({ target: { closest: () => true } });
  finish('code'); await send.settled;
  expect(b.ui().phase).toBe('details'); expect(b.ui().button.disabled).toBe(false);
  expect(b.history).toHaveLength(1);
});

it('shows the OTP terminal link without fetching or navigating to binary bytes', async () => {
  const target = '/console/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1';
  const b = await browser(target);
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); b.reply(1, 'download'); await verify.settled;
  expect(b.ui().phase).toBe('download');
  expect(b.ui().querySelector('#signin-download').getAttribute('href')).toBe(target);
  expect(b.requests.map(request => request.url)).toEqual(['https://fixture.test/console/signin', 'https://fixture.test/console/verify']);
  expect(b.navigations).toEqual([]);
  expect(b.ui().status.textContent).toBe('');
});
it('rejects a terminal link different from the submitted download intent', async () => {
  const target = '/console/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1';
  const b = await browser(target);
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); b.reply(1, JSON.stringify({ phase: 'download', values: { return_to: 'https://evil.test/' } })); await verify.settled;
  expect(b.ui().phase).toBe('code');
  expect(b.ui().status.textContent).toContain('Could not confirm');
  expect(b.navigations).toEqual([]);
});
it('restores terminal and details screens on Back and Forward without repeating OTP or binary reads', async () => {
  const target = '/console/workspace/file?id=def993c9-db4d-49c4-8998-8465bed3606e&revision=1';
  const b = await browser(target);
  const send = b.submit(); b.reply(0, 'code'); await send.settled;
  const verify = b.submit(); b.reply(1, 'download'); await verify.settled;
  await b.events.popstate!({ state: { waldoSignin: 'details' } });
  expect(b.ui().phase).toBe('details');
  await b.events.popstate!({ state: { waldoSignin: 'download' } });
  expect(b.ui().phase).toBe('download');
  expect(b.ui().querySelector('#signin-download').getAttribute('href')).toBe(target);
  expect(b.requests).toHaveLength(2);
  expect(b.navigations).toEqual([]);
});
