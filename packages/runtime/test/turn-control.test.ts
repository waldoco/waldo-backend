import { describe, expect, it } from 'vitest';
import { turnControl } from '../src/channels/turn-control';
import { renderForModel } from '../src/channels/owner-inbound-turn';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const said = (text: string) => ({ text, foreignRanges: [] });
const running = (fromOwner = true) => { const control = turnControl(); control.bindTarget('run'); control.begin(fromOwner); return control; };

describe('turn control', () => {
  it('stops a running turn before its next round and ignores stop when idle', async () => {
    const control = turnControl();
    control.bindTarget('run');
    expect(control.stopTarget('run')).toBe(false);
    control.begin(true);
    expect(await control.roundAsync()).toBe('');
    expect(control.stopTarget('run')).toBe(true);
    expect(await control.roundAsync()).toBeNull();
    expect(control.steerTarget('run', 5, said('late'))).toBe(false);
    control.end();
    control.bindTarget('run');
    control.begin(true);
    expect(await control.roundAsync()).toBe('');
  });

  it('feeds steers into the next round, absorbs only what the turn saw, and returns what it heard', async () => {
    const control = turnControl();
    control.bindTarget('run');
    expect(control.steerTarget('run', 1, said('idle'))).toBe(false);
    control.begin(true);
    await control.roundAsync();
    control.steerTarget('run', 2, said('make it Friday instead'));
    expect(await control.roundAsync()).toContain('the owner added: "make it Friday instead"');
    control.steerTarget('run', 3, said('arrived after the last round'));
    expect(control.end()).toEqual([said('make it Friday instead')]);
    expect(control.absorbed(2)).toBe(true);
    expect(control.absorbed(2)).toBe(false);
    expect(control.absorbed(3)).toBe(false);
  });

  it('does not steer scheduled turns, so owner messages during a card get their own answer', () => {
    const control = running(false);
    expect(control.steerTarget('run', 9, said('hi'))).toBe(false);
    expect(control.stopTarget('run')).toBe(true);
  });

  it('drops steers left over from an earlier turn instead of absorbing them later', async () => {
    const control = running();
    control.steerTarget('run', 7, said('too late'));
    control.end();
    control.bindTarget('run');
    control.begin(true);
    await control.roundAsync();
    expect(control.absorbed(7)).toBe(false);
  });
});

it('durable steer consumption commits before text reaches a model round', async () => {
  const control = running(); control.steerTarget('run', 91, said('more context'));
  let committed = false; control.durableConsume(async ids => { expect(ids).toEqual([91]); committed = true; });
  expect(await control.roundAsync()).toContain('more context'); expect(committed).toBe(true); expect(control.absorbed(91)).toBe(true);
});
it('failed durable consumption never exposes steer text and a target stop never survives begin', async () => {
  const control = running(); control.steerTarget('run', 92, said('uncommitted'));
  control.durableConsume(async () => { throw new Error('commit failed'); });
  await expect(control.roundAsync()).rejects.toThrow('commit failed'); expect(control.heard()).toEqual([]);
  control.stopTarget('run'); expect(await control.roundAsync()).toBeNull(); control.end(); control.begin(true); expect(await control.roundAsync()).toBe('');
});
it('target-scoped stop and steer cannot hit the next running turn after an await', async()=>{
  const control=turnControl();control.bindTarget('first');control.begin(true);control.end();control.bindTarget('second');control.begin(true);
  expect(control.stopTarget('first')).toBe(false);expect(control.steerTarget('first',1,{text:'old',foreignRanges:[]})).toBe(false);expect(await control.roundAsync()).toBe('');expect(control.stopTarget('second')).toBe(true);expect(await control.roundAsync()).toBeNull();
});

it('reports steers that arrived after the last round as unconsumed, so the host can answer them', async () => {
  const control = running();
  await control.roundAsync();
  control.steerTarget('run', 2, said('seen'));
    await control.roundAsync();
    control.steerTarget('run', 3, said('forget the rooms topic'));
    control.end();
    expect(control.unconsumed()).toEqual([{ id: 3, text: 'forget the rooms topic', foreignRanges: [] }]);
    control.begin(true);
    expect(control.unconsumed()).toEqual([]);
});

it('a plain-text owner steer reaches the model round exactly as its raw text did', async () => {
  const text = 'make it Friday instead';
  const parsed = await new TelegramPollingAdapter({ getUpdates: async () => [{ update_id: 1, message: { message_id: 1, date: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text } }] }, 0).poll(0);
  const steer = renderForModel(parsed.accepted[0]!.parts);
  expect(steer).toEqual({ text, foreignRanges: [] });
  const control = turnControl(); control.bindTarget('run'); control.begin(true);
  expect(control.steerTarget('run', 1, steer)).toBe(true);
  expect(await control.roundAsync()).toBe(`\n\n[While you were working, the owner added: ${JSON.stringify(text)}. Take it into account in this answer.]`);
});
