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
  beforeHandoff(intentDigest: string): Promise<void>;
  // Trusted owner-only custody: encrypt/store with existing owner keys and exact
  // approved audience. Never place this bearer in model output, logs or traces.
  storeOwnerView(view: GeneralOwnerView): Promise<void>;
}>;
// These are provider documented limits, not retry or task-lifetime extensions.
const MIN_VIEW_MS = 60000, MAX_VIEW_MS = 3600000, MAX_HANDOFF_MS = 1800000;

export async function generalBrowserHandoff(cdp: CDPSession, request: GeneralHandoffRequest, options: GeneralHandoffControl & Readonly<{ scope: GeneralHandoffScope; onMintAttempt?(): void }>) {
  const remaining = options.deadline() - options.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > Math.min(remaining, MAX_HANDOFF_MS)
    || !Number.isSafeInteger(request.viewExpiresInMs) || request.viewExpiresInMs < MIN_VIEW_MS || request.viewExpiresInMs > Math.min(remaining, MAX_VIEW_MS)
    || typeof request.instructions !== 'string' || !request.instructions.trim() || request.instructions.length > 4096 || options.signal.aborted) throw new GeneralHandoffError('rejected');
  const scope = options.scope, end = Math.min(options.deadline(), options.now() + request.timeoutMs);
  let mintAttempted = false, handoffId: string | undefined, early: HandoffCompleteResponse | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveEvent!: (event: HandoffCompleteResponse) => void, rejectEvent!: (error: GeneralHandoffError) => void;
  const completion = new Promise<HandoffCompleteResponse>((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject; });
  // Cancellation may happen while provider/custody I/O is awaited. Keep the
  // bounded failure handled until it can be surfaced after that await finishes.
  void completion.catch(() => {});
  const listener = (event: HandoffCompleteResponse) => {
    if (event?.targetId !== scope.targetId || typeof event.handoffId !== 'string' || typeof event.success !== 'boolean') return;
    if (!handoffId) early = { targetId: event.targetId, handoffId: event.handoffId, success: event.success };
    else if (event.handoffId === handoffId) resolveEvent({ targetId: event.targetId, handoffId, success: event.success });
  };
  const abort = () => rejectEvent(new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected'));
  const admit = async () => {
    if (options.signal.aborted || options.now() >= end) throw new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected');
    await options.admit();
    if (options.signal.aborted || options.now() >= end) throw new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected');
  };
  let subscribed = false;
  try {
    await admit();
    if ((await cdp.send('Cloudflare.getSessionId')).sessionId !== scope.providerSessionId) throw new GeneralHandoffError('rejected');
    await admit();
    if ((await cdp.send('Cloudflare.getHandoffState', { targetId: scope.targetId })).active) throw new GeneralHandoffError('rejected');
    await admit(); await options.beforeHandoff(await generalDigest(JSON.stringify({ scope, request }))); await admit();
    // Subscribe before both minting and initiating, as required by provider docs.
    (cdp.on as (name: string, callback: typeof listener) => unknown)('Cloudflare.handoffComplete', listener); subscribed = true;
    options.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => rejectEvent(new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected')), Math.max(0, end - options.now()));
    // Approval/custody preparation may consume time: recheck the actual
    // remaining connection-start authority immediately before minting.
    if (request.viewExpiresInMs > options.deadline() - options.now()) throw new GeneralHandoffError('rejected');
    const mintedAt = options.now();
    options.onMintAttempt?.(); mintAttempted = true;
    const view = await cdp.send('Cloudflare.getLiveView', { targetId: scope.targetId, mode: 'tab', expiresInMs: request.viewExpiresInMs });
    await admit();
    const url = new URL(view.devtoolsFrontendUrl);
    if (view.id !== scope.targetId || url.protocol !== 'https:' || url.hostname !== 'live.browser.run' || url.port || url.username || url.password || url.pathname !== '/ui/view' || url.searchParams.get('mode') !== 'tab' || !url.searchParams.get('wss')) throw new GeneralHandoffError('outcome_uncertain');
    const expiresAt = Math.min(options.deadline(), mintedAt + request.viewExpiresInMs);
    // A generated link's expiry limits connection start, not an established
    // viewer. The host must physically end the session on scope withdrawal.
    const handoff = await cdp.send('Cloudflare.handoff', { targetId: scope.targetId, instructions: request.instructions, timeout: end - options.now() });
    await admit();
    if (handoff.targetId !== scope.targetId || typeof handoff.handoffId !== 'string' || !handoff.handoffId) throw new GeneralHandoffError('outcome_uncertain');
    handoffId = handoff.handoffId;
    if (early?.handoffId === handoffId) resolveEvent(early);
    await options.storeOwnerView({ ...scope, handoffId, expiresAt, url: view.devtoolsFrontendUrl }); await admit();
    const event = await completion; await admit();
    const handoffRef = `handoff:${(await generalDigest(JSON.stringify({ scope, handoffId }))).slice(0, 24)}`; await admit();
    return { handoff_ref: handoffRef, status: 'provider_reported' as const, reported_success: event.success };
  } catch (error) {
    const failure = error instanceof GeneralHandoffError ? error : new GeneralHandoffError(mintAttempted ? 'outcome_uncertain' : 'rejected');
    if (mintAttempted) failure.view_mint_attempted = true;
    throw failure;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    if (subscribed) (cdp.off as (name: string, callback: typeof listener) => unknown)('Cloudflare.handoffComplete', listener);
  }
}
