import type { ConnectIntent } from '@waldo/contracts';

// A tool that needs Google says only what is missing. The tool loop adds what happened to the connect offer, so the
// model hears of a connect button only when one reached the owner.
export const connectNeededText = (reason: ConnectIntent['reason'], feature?: ConnectIntent['feature']): string => {
  const what = feature ? `Google (${feature})` : 'Google';
  return reason === 'not_connected' ? `${what} is not connected.` : reason === 'reauth_needed' ? `The ${what} grant expired.` : `${what} is not authorized for this account yet.`;
};
export const CONNECT_BUTTON_SENT = 'A connect button is in the chat (or was just sent). Tell the owner to tap it - never quote or retype any link yourself.';
export const CONNECT_BUTTON_UNSENT = 'No connect button was sent. Never quote or retype any link yourself.';
