import { expect, it } from 'vitest';
import { BrowserLoginTransitionError, expireLogin, loginPausesAutomation, nextLoginState } from '../src/channels/browser-login-handoff';

it('walks requested, owner control, owner done and one confirmation', () => {
  expect(nextLoginState('requested', { type: 'owner_opened' }, 1, 10)).toBe('owner_in_control');
  expect(nextLoginState('owner_in_control', { type: 'owner_done' }, 2, 10)).toBe('owner_done');
  expect(nextLoginState('owner_done', { type: 'confirmed', signedIn: true }, 3, 10)).toBe('signed_in');
  expect(nextLoginState('owner_done', { type: 'confirmed', signedIn: false }, 3, 10)).toBe('failed');
});

it('pauses automation until the owner hands control back', () => {
  expect(['requested', 'owner_in_control', 'owner_done', 'signed_in'].map(state => loginPausesAutomation(state as never))).toEqual([true, true, false, false]);
});

it('never confirms before the owner is done, and never leaves a terminal state', () => {
  expect(() => nextLoginState('owner_in_control', { type: 'confirmed', signedIn: true }, 1, 10)).toThrow(BrowserLoginTransitionError);
  expect(() => nextLoginState('signed_in', { type: 'owner_done' }, 1, 10)).toThrow(BrowserLoginTransitionError);
  expect(() => nextLoginState('cancelled', { type: 'cancel' }, 1, 10)).toThrow(BrowserLoginTransitionError);
});

it('a completion after the deadline expires the handoff instead of reviving it', () => {
  expect(nextLoginState('owner_in_control', { type: 'owner_done' }, 10, 10)).toBe('expired');
  expect(nextLoginState('owner_done', { type: 'confirmed', signedIn: true }, 11, 10)).toBe('expired');
  expect(nextLoginState('requested', { type: 'cancel' }, 11, 10)).toBe('cancelled');
  expect(expireLogin('owner_in_control', 10, 10)).toBe('expired');
  expect(expireLogin('signed_in', 99, 10)).toBe('signed_in');
});
