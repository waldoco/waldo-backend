import type { ConsoleAction } from './console';
import type { ControlReceipt } from './dashboard-control-actions';
import { phoneSms, type OwnerPhoneState, type PhoneSmsEnv, type PhoneSmsOutcome } from '../identity/phone-sms';

export type PhoneControls = Readonly<{ version: 1; view: 'phone'; state: 'available'; csrf: string;
  data: OwnerPhoneState & Readonly<{ actions: readonly ('phone.sms_send' | 'phone.sms_check')[] }> }>;

// The number on file and how to prove it. Texting a code is listed only while it is offered, the number is unproven
// and nothing is in flight; checking only while a code is waiting. The ledger re-checks both when the owner acts.
export async function phoneControls(env: PhoneSmsEnv, owner: string, csrf: string): Promise<PhoneControls> {
  if (!owner) throw new Error('owner_unbound');
  const sms = phoneSms(env);
  const state = await sms.state(owner) ?? { phone: null, verified: false, sms: sms.offered, challenge: null };
  const open = state.sms && state.phone !== null && !state.verified, waiting = state.challenge?.state;
  const actions = [...(open && waiting !== 'sending' && waiting !== 'checking' ? ['phone.sms_send' as const] : []),
    ...(open && waiting === 'pending' ? ['phone.sms_check' as const] : [])];
  return { version: 1, view: 'phone', state: 'available', csrf, data: { ...state, actions } };
}

const rejected = (message: string): ControlReceipt => ({ state: 'rejected', message });
const SENT: Readonly<Record<PhoneSmsOutcome['kind'], ControlReceipt>> = {
  pending: { state: 'recorded', message: 'Twilio is texting a code to your number on file. Enter it here within 10 minutes.' },
  unknown: { state: 'unconfirmed', message: 'Twilio did not confirm the text. Refresh before asking again; an unconfirmed text holds your number for up to an hour.' },
  no_number: rejected('There is no phone number on file, so no code was sent.'),
  verified: rejected('Your number is already verified, so no code was sent.'),
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
  expired: rejected('That code has expired. Ask for a new one.'),
  throttled: rejected('Too many tries. Ask for a new code, or try again later.'),
  number_taken: rejected('This number cannot be verified on this account.'),
  busy: rejected('A code is already being checked. Refresh in a moment.'),
  verified: rejected('Your number is already verified.'),
  no_number: rejected('There is no phone number on file.'),
  held: rejected('That code could not be checked. Refresh and try again.'),
  denied: rejected('That code could not be checked. Refresh and try again.'),
  disabled: rejected('Texting a code is not available on this server.'),
};

// The receipt never holds the code or the number.
export async function phoneControlAct(env: PhoneSmsEnv, owner: string, action: ConsoleAction, fields: Readonly<Record<string, string>>): Promise<ControlReceipt> {
  const sms = phoneSms(env);
  if (action.action === 'phone.sms_send') return SENT[(await sms.send(owner)).kind];
  const code = (fields.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return rejected('Enter the six digits from the text.');
  return CHECKED[(await sms.check(owner, code)).kind];
}
