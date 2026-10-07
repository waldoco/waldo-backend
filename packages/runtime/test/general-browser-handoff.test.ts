import { expect, it, vi } from 'vitest';
import { generalBrowserHandoff } from '../src/channels/cloudflare-general-handoff';
function fixture() {
  const calls: any[] = [], listeners = new Set<(event: any) => void>();
  const scope = { ownerId: 'owner-a', sessionId: 'host-session', generation: 1, providerSessionId: 'provider-session', targetId: 'target-a' };
  const emit = (event: any) => { for (const listener of listeners) listener(event); };
  const cdp = { on: (_: string, listener: any) => { listeners.add(listener); }, off: (_: string, listener: any) => { listeners.delete(listener); }, send: async (method: string, params?: any) => {
    calls.push([method, params]);
    if (method === 'Cloudflare.getSessionId') return { sessionId: scope.providerSessionId };
    if (method === 'Cloudflare.getHandoffState') return { active: false };
    if (method === 'Cloudflare.getLiveView') return { id: scope.targetId, devtoolsFrontendUrl: 'https://live.browser.run/ui/view?mode=tab&wss=synthetic-private-bearer', webSocketDebuggerUrl: 'wss://live.browser.run/synthetic-private-bearer', options: {} };
    if (method === 'Cloudflare.handoff') { emit({ targetId: scope.targetId, handoffId: 'handoff-a', success: true }); return { targetId: scope.targetId, handoffId: 'handoff-a' }; }
  } };
  const controller = new AbortController();
  const options = { scope, now: () => 1, deadline: () => 120001, admit: async () => {}, beforeHandoff: async () => { calls.push(['approval']); }, storeOwnerView: async (view: any) => { calls.push(['private-custody', view]); }, signal: controller.signal };
  return { cdp, options, calls, emit, controller, listeners };
}
it('subscribes before initiating, records private owner view, and correlates an early completion event', async () => {
  const f = fixture();
  const result = await generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect this public fixture', timeoutMs: 60000, viewExpiresInMs: 60000 }, f.options);
  expect(result).toMatchObject({ status: 'provider_reported', reported_success: true });
  expect(JSON.stringify(result)).not.toContain('synthetic-private-bearer');
  expect(f.calls.find(call => call[0] === 'Cloudflare.getLiveView')[1]).toEqual({ targetId: 'target-a', mode: 'tab', expiresInMs: 60000 });
  expect(f.calls.find(call => call[0] === 'private-custody')[1]).toMatchObject({ ownerId: 'owner-a', sessionId: 'host-session', generation: 1, targetId: 'target-a', handoffId: 'handoff-a' });
  expect(f.calls.findIndex(call => call[0] === 'approval')).toBeLessThan(f.calls.findIndex(call => call[0] === 'Cloudflare.getLiveView'));
  expect(f.listeners.size).toBe(0);
});
it('rejects insufficient remaining authority before minting a view', async () => {
  const f = fixture(); f.options.deadline = () => 60000;
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls).toEqual([]);
});
it('never treats inactive polling as successful intervention', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), send = f.cdp.send;
    f.cdp.send = async (method, params) => method === 'Cloudflare.handoff' ? { targetId: 'target-a', handoffId: 'handoff-a' } as any : send(method, params);
    const result = generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options);
    const rejection = expect(result).rejects.toMatchObject({ code: 'outcome_uncertain' });
    await vi.waitFor(() => expect(f.calls.some(call => call[0] === 'private-custody')).toBe(true));
    await vi.advanceTimersByTimeAsync(1000); await rejection;
    expect(f.listeners.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('ignores completion events for another target or handoff', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), send = f.cdp.send;
    f.cdp.send = async (method, params) => {
      if (method === 'Cloudflare.handoff') { f.emit({ targetId: 'target-b', handoffId: 'handoff-a', success: true }); f.emit({ targetId: 'target-a', handoffId: 'handoff-b', success: true }); return { targetId: 'target-a', handoffId: 'handoff-a' } as any; }
      return send(method, params);
    };
    const result = generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options);
    const rejection = expect(result).rejects.toMatchObject({ code: 'outcome_uncertain' });
    await vi.waitFor(() => expect(f.calls.some(call => call[0] === 'private-custody')).toBe(true));
    await vi.advanceTimersByTimeAsync(1000); await rejection;
  } finally { vi.useRealTimers(); }
});
it('does not mint after approval is withdrawn and normalizes private provider errors', async () => {
  const f = fixture(); f.options.beforeHandoff = async () => { throw Error('private owner approval denied'); };
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'rejected', message: 'browser_handoff_rejected' });
  expect(f.calls.some(call => call[0] === 'Cloudflare.getLiveView')).toBe(false);
});
it('rejects a provider session mismatch before minting', async () => {
  const f = fixture(), send = f.cdp.send;
  f.cdp.send = async (method, params) => method === 'Cloudflare.getSessionId' ? { sessionId: 'another-owner-session' } as any : send(method, params);
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.some(call => call[0] === 'Cloudflare.getLiveView')).toBe(false);
});
it('rechecks remaining authority after approval before minting', async () => {
  const f = fixture(); let now = 1;
  f.options.now = () => now; f.options.deadline = () => 60001;
  f.options.beforeHandoff = async () => { now = 2; };
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.some(call => call[0] === 'Cloudflare.getLiveView')).toBe(false);
});
it('marks a minted private-view custody failure uncertain without returning provider text or URL', async () => {
  const f = fixture(); f.options.storeOwnerView = async () => { throw Error('synthetic-private-bearer'); };
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'outcome_uncertain', view_mint_attempted: true, message: 'browser_handoff_outcome_uncertain' });
  expect(f.listeners.size).toBe(0);
});
it('returns only a correlated provider failure report, never task-completion proof', async () => {
  const f = fixture(), send = f.cdp.send;
  f.cdp.send = async (method, params) => {
    if (method === 'Cloudflare.handoff') { f.emit({ targetId: 'target-a', handoffId: 'handoff-a', success: false, reason: 'private provider prose' }); return { targetId: 'target-a', handoffId: 'handoff-a' } as any; }
    return send(method, params);
  };
  const result = await generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options);
  expect(result).toMatchObject({ status: 'provider_reported', reported_success: false });
  expect(JSON.stringify(result)).not.toContain('private provider prose');
});
it('does not retain event listeners after an owner abort', async () => {
  const f = fixture(); f.controller.abort();
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls).toEqual([]); expect(f.listeners.size).toBe(0);
});
it.each(['Cloudflare.getSessionId', 'Cloudflare.getHandoffState', 'Cloudflare.getLiveView', 'Cloudflare.handoff', 'approval', 'custody'])('abort bounds a stalled %s operation', async phase => {
  const f = fixture(), send = f.cdp.send;
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const hang = async (): Promise<any> => { started(); return new Promise(() => {}); };
  f.cdp.send = async (method, params) => method === phase ? hang() : send(method, params);
  if (phase === 'approval') f.options.beforeHandoff = hang;
  if (phase === 'custody') f.options.storeOwnerView = hang;
  const result = generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options);
  const rejection = expect(result).rejects.toMatchObject({ code: ['Cloudflare.getLiveView', 'Cloudflare.handoff', 'custody'].includes(phase) ? 'outcome_uncertain' : 'rejected' });
  await entered; f.controller.abort(); await rejection;
  expect(f.listeners.size).toBe(0);
});
it('keeps a valid early completion when another handoff event arrives later', async () => {
  const f = fixture(), send = f.cdp.send;
  f.cdp.send = async (method, params) => {
    if (method === 'Cloudflare.handoff') {
      f.emit({ targetId: 'target-a', handoffId: 'handoff-a', success: true });
      f.emit({ targetId: 'target-a', handoffId: 'old-handoff', success: false });
      return { targetId: 'target-a', handoffId: 'handoff-a' } as any;
    }
    return send(method, params);
  };
  await expect(generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options)).resolves.toMatchObject({ reported_success: true });
});
it.each(['Cloudflare.getSessionId', 'Cloudflare.getLiveView', 'Cloudflare.handoff', 'approval', 'custody'])('actual deadline bounds a stalled %s operation', async phase => {
  vi.useFakeTimers();
  try {
    const f = fixture(), send = f.cdp.send;
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const hang = async (): Promise<any> => { started(); return new Promise(() => {}); };
    f.cdp.send = async (method, params) => method === phase ? hang() : send(method, params);
    if (phase === 'approval') f.options.beforeHandoff = hang;
    if (phase === 'custody') f.options.storeOwnerView = hang;
    const result = generalBrowserHandoff(f.cdp as never, { instructions: 'Inspect', timeoutMs: 1000, viewExpiresInMs: 60000 }, f.options);
    const rejection = expect(result).rejects.toMatchObject({ code: ['Cloudflare.getLiveView', 'Cloudflare.handoff', 'custody'].includes(phase) ? 'outcome_uncertain' : 'rejected' });
    await entered; await vi.advanceTimersByTimeAsync(1000); await rejection;
    expect(f.listeners.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
