import type { ConsoleAction } from './console';
import type { ControlReceipt } from './dashboard-control-actions';
import { APP_PHONE_SET_RECEIPTS_V1 } from '../../../contracts/src/app/controls';
import { phoneSms, type OwnerPhoneState, type PhoneSetOutcome, type PhoneSmsEnv, type PhoneSmsOutcome } from '../identity/phone-sms';

type IMessageFrom = 'none' | 'number' | 'email' | 'other_number';
export type PhoneControls = Readonly<{ version: 1; view: 'phone'; state: 'available'; csrf: string;
  data: OwnerPhoneState & Readonly<{ actions: readonly ('phone.sms_send' | 'phone.sms_check' | 'phone.set')[]; proof: readonly ('sms' | 'imessage')[]; imessage_from?: IMessageFrom }> }>;

// The other way to prove a number: the owner sends their iMessage link code from it, and redeeming it proves the number on
// file when the handle is that number. offered: whether this server issues that code to this owner (it rejects when the
// directory cannot say); hint: the last characters of the handle their iMessage is linked from, null when not linked.
export type IMessageProof = Readonly<{ offered(): Promise<boolean>; hint(): Promise<string | null> }>;
const NO_IMESSAGE: IMessageProof = { offered: async () => false, hint: async () => null };
// Linking the directory cannot confirm counts as not offered, so the view still answers.
const linkable = (imessage: IMessageProof) => imessage.offered().catch(() => false);
// An Apple ID email ends in letters; a number's hint is its last digits.
const imessageFrom = (hint: string | null, phone: string | null): IMessageFrom =>
  hint === null ? 'none' : !/^\d+$/.test(hint) ? 'email' : phone?.endsWith(hint) ? 'number' : 'other_number';

// The number on file and how to prove it. Texting a code is listed only while it is offered, the number is unproven,
// nothing is in flight and the ledger's wait has passed; checking only while a code is waiting with checks left; setting
// the number to an active owner while it can be proven, by a texted code or an iMessage link code. The ledger re-checks
// each when the owner acts, and also applies the daily caps, which this read does not show.
export async function phoneControls(env: PhoneSmsEnv, owner: string, csrf: string, imessage: IMessageProof = NO_IMESSAGE, now = Date.now()): Promise<PhoneControls> {
  if (!owner) throw new Error('owner_unbound');
  const sms = phoneSms(env);
  const [read, byLink] = await Promise.all([sms.state(owner), linkable(imessage)]);
  const state = read ?? { phone: null, verified: false, sms: sms.offered, challenge: null };
  const open = state.sms && state.phone !== null && !state.verified, challenge = state.challenge;
  const sendable = !challenge || (challenge.state !== 'sending' && challenge.state !== 'checking' && (challenge.retry_at === null || challenge.retry_at * 1000 <= now));
  const actions = [...(open && sendable ? ['phone.sms_send' as const] : []),
    ...(open && challenge?.state === 'pending' && challenge.checks_left > 0 ? ['phone.sms_check' as const] : []),
    ...((sms.offered || byLink) && read !== null ? ['phone.set' as const] : [])];
  const proof = [...(sms.offered ? ['sms' as const] : []), ...(byLink ? ['imessage' as const] : [])];
  const hint = byLink ? await imessage.hint().catch(() => undefined) : undefined;
  return { version: 1, view: 'phone', state: 'available', csrf, data: { ...state, actions, proof, ...(hint !== undefined ? { imessage_from: imessageFrom(hint, state.phone) } : {}) } };
}

const rejected = (message: string): ControlReceipt => ({ state: 'rejected', message });
const SENT: Readonly<Record<PhoneSmsOutcome['kind'], ControlReceipt>> = {
  pending: { state: 'recorded', message: 'Twilio is texting a code to your number on file. Enter it here within 10 minutes.' },
  unknown: { state: 'unconfirmed', message: 'Twilio did not confirm the text. Refresh before asking again; an unconfirmed text holds your number for up to an hour.' },
  no_number: rejected('There is no phone number on file, so no code was sent.'),
  verified: rejected('Your number is already verified, so no code was sent.'),
  unsupported: rejected('No code was sent: Waldo cannot text numbers in this country yet.'),
  refused: rejected('No code was sent: Twilio turned the request down. Try again later.'),
  number_taken: rejected('No code was sent: this number cannot be verified on this account.'),
  held: rejected('No code can be sent to this number right now. Try again in a few minutes.'),
  busy: rejected('A code is already on its way. Refresh in a moment.'),
  throttled: rejected('No code was sent: that is the limit for now. Try again later.'),
  expired: rejected('No code was sent. Refresh and try again.'),
  approved: rejected('No code was sent. Refresh and try again.'),
  denied: rejected('No code was sent. Refresh and try again.'),
  disabled: rejected('Texting a code is not available on this server.'),
};
const CHECKED: Readonly<Record<PhoneSmsOutcome['kind'], ControlReceipt>> = {
  approved: { state: 'recorded', message: 'Your number is verified.' },
  unknown: { state: 'unconfirmed', message: 'The check was not confirmed. Refresh to see whether your number is verified.' },
  pending: rejected('That code did not match. Check it and try again.'),
  refused: rejected('That code could not be checked: Twilio turned the request down. Try again in a minute.'),
  expired: rejected('That code has expired. Ask for a new one.'),
  throttled: rejected('Too many tries. Ask for a new code, or try again later.'),
  number_taken: rejected('This number cannot be verified on this account.'),
  busy: rejected('A code is already being checked. Refresh in a moment.'),
  verified: rejected('Your number is already verified.'),
  no_number: rejected('There is no phone number on file.'),
  unsupported: rejected('That code could not be checked. Refresh and try again.'),
  held: rejected('That code could not be checked. Refresh and try again.'),
  denied: rejected('That code could not be checked. Refresh and try again.'),
  disabled: rejected('Texting a code is not available on this server.'),
};

const SET: Readonly<Record<PhoneSetOutcome['kind'], ControlReceipt>> = {
  ...APP_PHONE_SET_RECEIPTS_V1, denied: APP_PHONE_SET_RECEIPTS_V1.unavailable, disabled: APP_PHONE_SET_RECEIPTS_V1.unavailable,
};

// The receipt never holds the code or the number. A change of number unlinks, in the directory, the chats linked from the
// old one; what the owner DO holds for a WhatsApp chat (the bound sender, its held and outbox messages) is cleared through
// whatsappUnlinked, as the WhatsApp unlink action does. An iMessage unlink is the directory's alone, as in that action.
export async function phoneControlAct(env: PhoneSmsEnv, owner: string, action: ConsoleAction, fields: Readonly<Record<string, string>>,
  whatsappUnlinked: () => Promise<void>, imessage: IMessageProof = NO_IMESSAGE): Promise<ControlReceipt> {
  const sms = phoneSms(env);
  if (action.action === 'phone.set') {
    const outcome = await sms.set(owner, action.value, !sms.offered && await linkable(imessage));
    if (outcome.unlinked?.includes('whatsapp')) await whatsappUnlinked();
    return outcome.unlinked?.length ? APP_PHONE_SET_RECEIPTS_V1.set_unlinked : SET[outcome.kind];
  }
  if (action.action === 'phone.sms_send') return SENT[(await sms.send(owner)).kind];
  const code = (fields.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return rejected('Enter the six digits from the text.');
  return CHECKED[(await sms.check(owner, code)).kind];
}
