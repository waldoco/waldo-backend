import type { CDPSession, HandoffCompleteResponse } from '@cloudflare/playwright';
import { generalDigest } from './general-browser-observation';

export class GeneralHandoffError extends Error {
  view_mint_attempted?: true;
  constructor(readonly code: 'rejected' | 'provider_unavailable' | 'outcome_uncertain') { super(`browser_handoff_${code}`); }
}
export type GeneralHandoffRequest = Readonly<{ instructions: string; timeoutMs: number; viewExpiresInMs: number }>;
export type GeneralHandoffScope = Readonly<{ ownerId: string; sessionId: string; generation: number; providerSessionId: string; targetId: string }>;
export type GeneralOwnerView = GeneralHandoffScope & Readonly<{ handoffId: string; expiresAt: number; url: string }>;
export type GeneralHandoffControl = Readonly<{
  now(): number; deadline(): number; admit(): Promise<void>; signal: AbortSignal;
  beforeHandoff(intentDigest: string, signal: AbortSignal): Promise<void>;
  // Trusted owner-only custody: encrypt/store with existing owner keys and exact
  // approved audience. Never place this bearer in model output, logs or traces.
  storeOwnerView(view: GeneralOwnerView, signal: AbortSignal): Promise<void>;
}>;
// These are provider documented limits, not retry or task-lifetime extensions.
const MIN_VIEW_MS = 60000, MAX_VIEW_MS = 3600000, MAX_HANDOFF_MS = 1800000;

export async function generalBrowserHandoff(cdp: CDPSession, request: GeneralHandoffRequest, options: GeneralHandoffControl & Readonly<{ scope: GeneralHandoffScope; onMintAttempt?(): void }>) {
  const remaining = options.deadline() - options.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > Math.min(remaining, MAX_HANDOFF_MS)
    || !Number.isSafeInteger(request.viewExpiresInMs) || request.viewExpiresInMs < MIN_VIEW_MS || request.viewExpiresInMs > Math.min(remaining, MAX_VIEW_MS)
    || typeof request.instructions !== 'string' || !request.instructions.trim() || request.instructions.length > 4096 || options.signal.aborted) throw new GeneralHandoffError('rejected');
  const scope = options.scope, end = Math.min(options.deadline(), options.now() + request.timeoutMs);
  let mintAttempted = false, handoffId: string | undefined;
  const early = new Map<string, HandoffCompleteResponse>(), lease = new AbortController();
  let resolveEvent!: (event: HandoffCompleteResponse) => void, rejectLease!: (error: GeneralHandoffError) => void;
  const completion = new Promise<HandoffCompleteResponse>(resolve => { resolveEvent = resolve; });
  const leaseFailure = new Promise<never>((_, reject) => { rejectLease = reject; });
  void leaseFailure.catch(() => {});
  const abort = () => { lease.abort(); rejectLease(new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected')); };
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, end - options.now()));
  const check = () => { if (lease.signal.aborted || options.signal.aborted || options.now() >= end) throw new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected'); };
  const bounded = async <T>(operation: () => Promise<T>, provider = false): Promise<T> => {
    check();
    try { const value = await Promise.race([operation(), leaseFailure]); check(); return value; }
    catch (error) { if (error instanceof GeneralHandoffError) throw error; throw new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : provider ? 'provider_unavailable' : 'rejected'); }
  };
  const admit = () => bounded(options.admit);
  const listener = (event: HandoffCompleteResponse) => {
    if (event?.targetId !== scope.targetId || typeof event.handoffId !== 'string' || typeof event.success !== 'boolean') return;
    const report = { targetId: event.targetId, handoffId: event.handoffId, success: event.success };
    if (!handoffId) { if (!early.has(event.handoffId)) early.set(event.handoffId, report); }
    else if (event.handoffId === handoffId) resolveEvent(report);
  };
  let subscribed = false;
  try {
    await admit();
    if ((await bounded(() => cdp.send('Cloudflare.getSessionId'), true)).sessionId !== scope.providerSessionId) throw new GeneralHandoffError('rejected');
    await admit();
    if ((await bounded(() => cdp.send('Cloudflare.getHandoffState', { targetId: scope.targetId }), true)).active) throw new GeneralHandoffError('rejected');
    await admit();
    const intent = await bounded(() => generalDigest(JSON.stringify({ scope, request })));
    await bounded(() => options.beforeHandoff(intent, lease.signal)); await admit();
    // Subscribe before both minting and initiating, as required by provider docs.
    (cdp.on as (name: string, callback: typeof listener) => unknown)('Cloudflare.handoffComplete', listener); subscribed = true;
    if (request.viewExpiresInMs > options.deadline() - options.now()) throw new GeneralHandoffError('rejected');
    const mintedAt = options.now();
    options.onMintAttempt?.(); mintAttempted = true;
    const view = await bounded(() => cdp.send('Cloudflare.getLiveView', { targetId: scope.targetId, mode: 'tab', expiresInMs: request.viewExpiresInMs }), true);
    await admit();
    const url = new URL(view.devtoolsFrontendUrl);
    if (view.id !== scope.targetId || url.protocol !== 'https:' || url.hostname !== 'live.browser.run' || url.port || url.username || url.password || url.pathname !== '/ui/view' || url.searchParams.get('mode') !== 'tab' || !url.searchParams.get('wss')) throw new GeneralHandoffError('outcome_uncertain');
    const expiresAt = Math.min(options.deadline(), mintedAt + request.viewExpiresInMs);
    // Expiry limits connection start, not an established viewer. Revocation
    // requires physical termination; caller custody must fence late commits.
    const handoff = await bounded(() => cdp.send('Cloudflare.handoff', { targetId: scope.targetId, instructions: request.instructions, timeout: end - options.now() }), true);
    await admit();
    if (handoff.targetId !== scope.targetId || typeof handoff.handoffId !== 'string' || !handoff.handoffId) throw new GeneralHandoffError('outcome_uncertain');
    handoffId = handoff.handoffId;
    const report = early.get(handoffId); early.clear(); if (report) resolveEvent(report);
    await bounded(() => options.storeOwnerView({ ...scope, handoffId: handoffId!, expiresAt, url: view.devtoolsFrontendUrl }, lease.signal)); await admit();
    const event = await bounded(() => completion); await admit();
    const handoffRef = `handoff:${(await bounded(() => generalDigest(JSON.stringify({ scope, handoffId })))).slice(0, 24)}`; await admit();
    return { handoff_ref: handoffRef, status: 'provider_reported' as const, reported_success: event.success };
  } catch (error) {
    const failure = error instanceof GeneralHandoffError ? error : new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected');
    if (mintAttempted) failure.view_mint_attempted = true;
    throw failure;
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    if (subscribed) (cdp.off as (name: string, callback: typeof listener) => unknown)('Cloudflare.handoffComplete', listener);
    early.clear();
  }
}
