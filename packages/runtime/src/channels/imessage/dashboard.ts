import type { ConsoleAction } from '../console';
import type { ControlReceipt, RevealingReceipt } from '../dashboard-control-actions';
import { consoleAuth } from '../../identity/console-auth';
import { iMessageBridgeName, iMessageComposition, type IMessageBridgeDO, type IMessageEnv } from './bridge-do';
import { ENROLL_REFUSED, iMessageAction, type IMessageOutcome } from './console';
import { iMessageNumberView, photonConnection } from './enrollment';
import { iMessageDirectory, type BridgeListing } from './directory';

type HostAction = 'imessage.verify' | 'imessage.activate' | 'imessage.activate_shared' | 'imessage.revoke';
export type IMessageControls = Readonly<{ version: 1; view: 'imessage'; state: 'available'; csrf: string; data: Readonly<{
  /** address: what this owner texts (their Photon number once enrolled). phone: the number to prefill for enrollment. */
  enabled: boolean; address: string | null; linked_hint: string | null; admin: boolean; phone: string | null; photon: 'connected' | 'disconnected' | null;
  /** The number on file and whether a link code has arrived from it; null where this server does not read it (no Photon). */
  phone_on_file: Readonly<{ phone: string; verified: boolean }> | null;
  actions: readonly ('imessage.enroll' | 'imessage.link' | 'imessage.unlink' | 'imessage.pair' | 'imessage.pair_shared')[];
  bridges: readonly Readonly<{ id: string; kind: 'owner' | 'shared'; state: string; subject: string | null; chat: string | null; observed: boolean; host_version: string; actions: readonly HostAction[] }>[];
}> }>;

// The decision-relevant read: every action it lists is the eligibility the action path re-checks.
// Host liveness changes with each heartbeat, so it is read beside this and never hashed into it.
async function readIMessage(env: IMessageEnv, owner: string, csrf: string): Promise<{ controls: IMessageControls; rows: readonly BridgeListing[] }> {
  if (!owner) throw new Error('owner_unbound');
  const disabled = { enabled: false, address: null, linked_hint: null, admin: false, phone: null, photon: null, phone_on_file: null, actions: [], bridges: [] };
  if (!iMessageComposition(env)) return { controls: { version: 1, view: 'imessage', state: 'available', csrf, data: disabled }, rows: [] };
  const auth = consoleAuth(env);
  const [rows, admin, hint, view] = await Promise.all([
    iMessageDirectory(env).list(owner),
    auth?.adminOverview(owner).then((v) => v !== null).catch(() => false) ?? false,
    auth?.iMessageHandleHint?.(owner) ?? null,
    iMessageNumberView(env, owner),
  ]);
  const photon = admin ? await photonConnection(env) : null;
  const bridges = rows.map((r) => {
    const shared = r.kind === 'shared', pending = r.state === 'pending';
    const actions: HostAction[] = [...(pending ? ['imessage.verify' as const] : []),
      ...(pending && r.observed && (!shared || admin) ? [shared ? 'imessage.activate_shared' as const : 'imessage.activate' as const] : []),
      ...(r.state === 'revoked' ? [] : ['imessage.revoke' as const])];
    return { id: r.bridge_id, kind: shared ? 'shared' as const : 'owner' as const, state: r.state, subject: r.subject, chat: r.chat_guid, observed: r.observed, host_version: r.host_version, actions };
  });
  const actions = [...(view.enrollable ? ['imessage.enroll' as const] : []), ...(view.number ? ['imessage.link' as const] : []), ...(hint !== null ? ['imessage.unlink' as const] : []),
    'imessage.pair' as const, ...(admin ? ['imessage.pair_shared' as const] : [])];
  return { controls: { version: 1, view: 'imessage', state: 'available', csrf, data: { enabled: true, address: view.number, linked_hint: hint, admin, phone: view.phone, photon, phone_on_file: view.onFile, actions, bridges } }, rows };
}

export const iMessageControls = async (env: IMessageEnv, owner: string, csrf: string): Promise<IMessageControls> => (await readIMessage(env, owner, csrf)).controls;

export async function iMessageControlsStatus(env: IMessageEnv, owner: string, csrf: string) {
  const { controls, rows } = await readIMessage(env, owner, csrf), c = iMessageComposition(env);
  const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>;
  const bridges = c ? await Promise.all(rows.filter((r) => r.state === 'active').map(async (r) => {
    const s = await ns.get(ns.idFromName(iMessageBridgeName(c.environment, r.bridge_id, r.account_id))).status();
    return { id: r.bridge_id, online: s.online, text_ready: s.textReady, sending_paused: s.quarantine !== null };
  })) : [];
  return { controls, status: { bridges } };
}

const recorded = (message: string): ControlReceipt => ({ state: 'recorded', message });
const DONE: Readonly<Record<string, string>> = {
  'imessage.unlink': 'iMessage unlinked. Texts from that number no longer reach your Waldo.',
  'imessage.activate': 'Mac host activated for that sender and chat.',
  'imessage.activate_shared': 'The shared Waldo number is active. Each sender still reaches only their own Waldo.',
  'imessage.revoke': 'Mac host revoked. It can no longer send or receive for your Waldo.',
};
// Codes and challenges are shown once, in this response only; the stored receipt never holds them.
function receiptFor(action: string, outcome: IMessageOutcome, address: string | null): ControlReceipt | RevealingReceipt {
  switch (outcome.kind) {
    case 'link_code': return { receipt: recorded(`Text this from your iPhone to ${outcome.address ?? address ?? 'the Waldo iMessage number'} within 10 minutes. The code works once; from then on only your number reaches your Waldo.`),
      reveal: { kind: 'link_code', value: `waldo ${outcome.code}`, ...((outcome.address ?? address) ? { to: (outcome.address ?? address)! } : {}) } };
    case 'host_code': return { receipt: recorded(outcome.shared ? `Give this code to the shared Waldo number's host. It goes live as soon as the host uses it. It works once and expires in ${outcome.minutes} minutes.`
      : `Enter this code on your Mac host. It works once and expires in ${outcome.minutes} minutes.`), reveal: { kind: 'host_code', value: outcome.code } };
    case 'challenge': return { receipt: recorded("Send this exact text from the sender you entered to your Mac's Messages account, in that direct chat. Then refresh and confirm it here."), reveal: { kind: 'challenge', value: outcome.challenge } };
    case 'done': return recorded(DONE[action] ?? 'The change was recorded.');
    case 'enroll_refused': return { state: 'rejected', message: ENROLL_REFUSED[outcome.reason] };
    case 'disabled': return { state: 'rejected', message: 'iMessage is not enabled on this server.' };
    case 'invalid': return { state: 'rejected', message: 'Check the sender and chat, then try again. Nothing was changed.' };
    case 'failed': return { state: 'rejected', message: 'That iMessage change was not applied. Refresh and try again.' };
    case 'unknown': return { state: 'unconfirmed', message: 'The outcome is not confirmed. Refresh the records before trying again.' };
  }
}

// Activation confirms the sender and chat the fresh read recorded, never values the browser sends.
export async function iMessageControlAct(env: IMessageEnv, owner: string, controls: IMessageControls, action: ConsoleAction, fields: Readonly<Record<string, string>>, onRevoked: (bridgeDoName: string) => void): Promise<ControlReceipt | RevealingReceipt> {
  const row = controls.data.bridges.find((bridge) => bridge.id === action.id);
  const confirm = action.action === 'imessage.activate' || action.action === 'imessage.activate_shared';
  const input = confirm ? { id: action.id, subject: row?.subject, chat: row?.chat } : { id: action.id, subject: fields.subject, chat: fields.chat, phone: fields.phone };
  return receiptFor(action.action, await iMessageAction(env, owner, action.action, input, onRevoked), controls.data.address);
}
