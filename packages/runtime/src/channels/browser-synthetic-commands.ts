import { browserTaskCommandSchema, type BrowserTaskCommand } from '@waldo/contracts';
import type { BrowserTaskDriver } from './browser-task-continuity';
import { fixtureDigest, type BrowserSourceGuard } from './public-fixture-browser';

// The first command journey uses a controlled form with known semantics. This
// transport has no live provider factory; provider activation requires S0 proof.
export type SyntheticCommand = Extract<BrowserTaskCommand, { operation: 'goto' | 'click' | 'type' | 'scroll' | 'read' | 'wait' }>;
export type SyntheticObservation = Readonly<{
  url: string; text: string;
  elements: readonly Readonly<{ ref: string; tag: 'a' | 'button' | 'input'; type?: string; field?: string; href?: string; inForm: boolean }>[];
  form: Readonly<{ action: string; method: string; values: Readonly<Record<string, string>> }>;
}>;
export type SyntheticRequest = Readonly<{ url: string; method: string; body?: string }>;
export type SyntheticTransport = Readonly<{
  start(lifetimeMs: number, allowRequest: (request: SyntheticRequest) => boolean): Promise<string>;
  observe(id: string): Promise<SyntheticObservation>;
  // The transport reobserves expectedDigest and invokes before immediately before
  // the physical action. Network requests must pass the start-installed policy.
  execute(id: string, command: SyntheticCommand, expectedDigest: string, before: BrowserSourceGuard, assertCurrent?: () => void): Promise<void>;
  close(id: string): Promise<void>; absent(id: string): Promise<boolean>;
  verify(bindingDigest: string): ReturnType<BrowserTaskDriver['verify']>;
}>;
const readOperations = ['goto', 'click', 'type', 'scroll', 'read', 'wait'];
export function parseSyntheticCommand(input: unknown): SyntheticCommand {
  const parsed = browserTaskCommandSchema.safeParse(input);
  if (!parsed.success || !readOperations.includes(parsed.data.operation)) throw Error('browser command rejected');
  return parsed.data as SyntheticCommand;
}
export function syntheticCommandAdapter(options: Readonly<{ origin: string; pageUrl: string; runId: string; submitRef: string; transport: SyntheticTransport }>) {
  const { transport } = options;
  const sameSite = (raw: string) => { try { const url = new URL(raw); return url.protocol === 'https:' && url.origin === options.origin && !url.username && !url.password; } catch { return false; } };
  if (!sameSite(options.pageUrl) || new URL(options.origin).origin !== options.origin) throw Error('synthetic site rejected');
  let permit: { action: string; body: string; assertApproval?: () => void } | undefined;
  let blockedWrites = 0;
  const allowRequest = (request: SyntheticRequest) => {
    const denied = () => { if (!['GET', 'HEAD'].includes(request.method)) blockedWrites++; return false; };
    if (!sameSite(request.url)) return denied();
    if (request.method === 'GET' || request.method === 'HEAD') return true;
    const current = permit;
    if (!current || request.method !== 'POST' || request.url !== current.action) return denied();
    try { current.assertApproval?.(); } catch { return denied(); }
    const actual = [...new URLSearchParams(request.body ?? '')].sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(actual) !== current.body) return denied();
    permit = undefined; // One approved request, including concurrent page requests.
    return true;
  };
  const isSubmitControl = (element: SyntheticObservation['elements'][number]) => element.tag === 'button' && (!element.type || element.type === 'submit') || element.tag === 'input' && ['submit', 'image'].includes(element.type ?? '');
  const isSubmitter = (element: SyntheticObservation['elements'][number]) => element.inForm && isSubmitControl(element);
  const observe = async (id: string) => {
    const state = structuredClone(await transport.observe(id));
    // DOM nesting alone cannot exclude a form=id association. Unknown external
    // submit controls are outside this first fixture and rejected before effects.
    const submitters = state.elements.filter(isSubmitControl);
    if (submitters.length !== 1 || !submitters[0]!.inForm || submitters[0]!.ref !== options.submitRef || state.url !== options.pageUrl || !sameSite(state.form.action) || state.form.method !== 'POST'
      || !state.elements.length || state.elements.length > 32 || new Set(state.elements.map(element => element.ref)).size !== state.elements.length
      || Object.keys(state.form.values).length > 24 || !Object.keys(state.form.values).length
      || Object.entries(state.form.values).some(([key, value]) => !key || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string' || value.length > 1000)
      || state.elements.some(element => element.tag === 'input' && (element.type === 'password' || element.type === 'hidden' || !isSubmitter(element) && (!element.field || !Object.hasOwn(state.form.values, element.field))))) throw Error('synthetic state rejected');
    return state;
  };
  const checked = async (id: string, digest: string) => { const state = await observe(id); if (await fixtureDigest(state) !== digest) throw Error('synthetic state changed'); return state; };
  const effect = async (id: string, command: SyntheticCommand, digest: string, before: BrowserSourceGuard, assertCurrent?: () => void) => {
    await before(); await checked(id, digest); assertCurrent?.();
    await transport.execute(id, command, digest, async () => { await before(); await checked(id, digest); assertCurrent?.(); }, assertCurrent);
  };
  return {
    provider: 'cloudflare_playwright' as const, origin: options.origin, pageUrl: options.pageUrl, runId: options.runId, submitRef: options.submitRef,
    async start(lifetimeMs: number, source?: BrowserSourceGuard) {
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 10000 || lifetimeMs > 600000) throw Error('synthetic lifetime rejected');
      await source?.(); return transport.start(lifetimeMs, allowRequest);
    },
    async navigate(id: string, source?: BrowserSourceGuard) { await source?.(); const state = await observe(id); await effect(id, { operation: 'goto', url: options.pageUrl }, await fixtureDigest(state), source ?? (async () => {})); },
    async inspect(id: string, source?: BrowserSourceGuard) {
      await source?.(); const state = await observe(id); await source?.();
      return { url: state.url, stateDigest: await fixtureDigest(state), binding: state.form.values, text: state.text,
        elements: state.elements.map(({ ref }) => ({ ref })), action: { url: state.form.action, method: 'POST' as const, fields: Object.keys(state.form.values).sort() } };
    },
    async command(id: string, input: unknown, digest: string, before: BrowserSourceGuard, _source?: BrowserSourceGuard, assertCurrent?: () => void) {
      const command = parseSyntheticCommand(input);
      if (command.operation === 'goto' && command.url !== options.pageUrl) throw Error('synthetic destination rejected');
      const state = await checked(id, digest);
      const element = 'element_ref' in command ? state.elements.find(element => element.ref === command.element_ref) : undefined;
      if ('element_ref' in command && !element) throw Error('synthetic element rejected');
      if (element?.tag === 'a' && (!element.href || element.href !== options.pageUrl)) throw Error('synthetic destination rejected');
      if (command.operation === 'type' && (element?.tag !== 'input' || !['text', 'email'].includes(element.type ?? ''))) throw Error('synthetic input rejected');
      const submit = command.operation === 'click' && element !== undefined && isSubmitter(element)
        || command.operation === 'type' && command.key === 'Enter' && element?.inForm;
      if (submit) return { held: true as const, nativeSubmit: true };
      if (command.intent === 'send') return { held: true as const, nativeSubmit: false };
      const beforeBlocked = blockedWrites;
      await effect(id, command, digest, before, assertCurrent);
      if (blockedWrites > beforeBlocked) return { held: true as const, nativeSubmit: false, reason: 'page_write_blocked' as const };
      return { held: false as const };
    },
    async fill(id: string, field: string, value: string, digest: string, before: BrowserSourceGuard, source?: BrowserSourceGuard, assertCurrent?: () => void) {
      await source?.(); const state = await checked(id, digest), element = state.elements.find(element => element.field === field);
      if (!element || element.tag !== 'input' || !['text', 'email'].includes(element.type ?? '') || !value || value.length > 1000) throw Error('synthetic field rejected');
      await effect(id, { operation: 'type', element_ref: element.ref, value }, digest, async () => { await source?.(); await before(); }, assertCurrent);
    },
    async submit(id: string, digest: string, before: BrowserSourceGuard, source?: BrowserSourceGuard, assertApproval?: () => void) {
      const state = await checked(id, digest);
      await source?.(); await before(); await checked(id, digest); assertApproval?.();
      permit = { action: state.form.action, body: JSON.stringify(Object.entries(state.form.values).sort(([a], [b]) => a.localeCompare(b))), assertApproval };
      try { await effect(id, { operation: 'click', element_ref: options.submitRef }, digest, async () => { await source?.(); await before(); assertApproval?.(); }, assertApproval); }
      finally { permit = undefined; }
    },
    async verify(digest: string, source?: BrowserSourceGuard) { await source?.(); const receipt = await transport.verify(digest); await source?.(); return receipt; },
    async end(id: string) { permit = undefined; await transport.close(id); if (!await transport.absent(id)) throw Error('synthetic cleanup unresolved'); },
  };
}
