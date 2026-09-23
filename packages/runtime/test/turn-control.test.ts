import { describe, expect, it } from 'vitest';
import { turnControl } from '../src/channels/turn-control';

describe('turn control', () => {
  it('stops a running turn before its next round and ignores stop when idle', () => {
    const control = turnControl();
    expect(control.stop()).toBe(false);
    control.begin(true);
    expect(control.round()).toBe('');
    expect(control.stop()).toBe(true);
    expect(control.round()).toBeNull();
    expect(control.steer(5, 'late')).toBe(false);
    control.end();
    control.begin(true);
    expect(control.round()).toBe('');
  });

  it('feeds steers into the next round, absorbs only what the turn saw, and returns what it heard', () => {
    const control = turnControl();
    expect(control.steer(1, 'idle')).toBe(false);
    control.begin(true);
    control.round();
    control.steer(2, 'make it Friday instead');
    expect(control.round()).toContain('the owner added: "make it Friday instead"');
    control.steer(3, 'arrived after the last round');
    expect(control.end()).toEqual(['make it Friday instead']);
    expect(control.absorbed(2)).toBe(true);
    expect(control.absorbed(2)).toBe(false);
    expect(control.absorbed(3)).toBe(false);
  });

  it('does not steer scheduled turns, so owner messages during a card get their own answer', () => {
    const control = turnControl();
    control.begin(false);
    expect(control.steer(9, 'hi')).toBe(false);
    expect(control.stop()).toBe(true);
  });

  it('drops steers left over from an earlier turn instead of absorbing them later', () => {
    const control = turnControl();
    control.begin(true);
    control.steer(7, 'too late');
    control.end();
    control.begin(true);
    control.round();
    expect(control.absorbed(7)).toBe(false);
  });
});
