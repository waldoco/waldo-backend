// Engine-neutral event harness for the script served by the real sign-in handler.
// Rendered Chrome checks supplement these lifecycle events; no provider is contacted.
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const browser = async () => {
  const response = await handleConsole(new Request('https://fixture.test/console/signin'),
    { TELEGRAM_OWNER_DO: {} as DurableObjectNamespace }, {} as ConsoleAuth);
  const script = (await response!.text()).match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const events: Record<string, (event?: unknown) => void> = {};
  const button = { disabled: false };
  const cancel = { hidden: true, disabled: false, addEventListener: (name: string, handler: () => void) => { events[`cancel-${name}`] = handler; } };
  let stopped = false;
  const code = { value: 'synthetic-otp' };
  const status = { textContent: '' };
  const attributes = new Map<string, string>();
  const form = { dataset: { pending: 'Checking your code…' },
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  const listen = (name: string, handler: (event?: unknown) => void) => { events[name] = handler; };
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => id === 'signin-code' ? code : id === 'signin-cancel' ? cancel : status,
      querySelectorAll: (selector: string) => selector === 'button' ? [button, cancel] : [form],
      addEventListener: listen,
    },
    window: { addEventListener: listen, stop: () => { stopped = true; } },
  });
  return { events, button, cancel, code, status, attributes, form, stopped: () => stopped };
};

describe('sign-in browser lifecycle', () => {
  it('locks repeated submissions with a visible pending state', async () => {
    const ui = await browser();
    ui.events.submit!({ target: ui.form });
    expect(ui.button.disabled).toBe(true);
    expect(ui.attributes.get('aria-busy')).toBe('true');
    expect(ui.status.textContent).toBe('Checking your code…');
    let prevented = false;
    ui.events.submit!({ target: ui.form, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
  });

  it('clears OTP on departure and restores enabled blank-code form on return', async () => {
    const ui = await browser();
    ui.events.submit!({ target: ui.form });
    ui.events.pagehide!();
    expect(ui.code.value).toBe('');
    // Browser restoration/autofill must not revive the previous OTP.
    ui.code.value = 'restored-synthetic-otp';
    ui.events.pageshow!();
    expect(ui.code.value).toBe('');
    expect(ui.button.disabled).toBe(false);
    expect(ui.attributes.has('aria-busy')).toBe(false);
    expect(ui.status.textContent).toBe('');
    ui.events.submit!({ target: ui.form });
    expect(ui.button.disabled).toBe(true);
  });
});

it('lets an interrupted request return to an editable form without implying failure or delivery', async () => {
  const ui = await browser();
  ui.events.submit!({ target: ui.form });
  expect(ui.cancel.hidden).toBe(false);
  expect(ui.cancel.disabled).toBe(false);
  ui.events['cancel-click']!();
  expect(ui.stopped()).toBe(true);
  expect(ui.button.disabled).toBe(false);
  expect(ui.code.value).toBe('');
  expect(ui.cancel.hidden).toBe(true);
  expect(ui.status.textContent).toContain('may have completed');
});
