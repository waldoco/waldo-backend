import { describe, expect, it } from 'vitest';
import { briefBodyAfter, briefBodyBefore, briefBodyPrompt, briefBodyRevision } from '../src/channels/brief-revision';

// BRIEF_BODY_REVISION: today's first health row written after the Daily Brief reached the owner has the Brief looked at once
// more. Code decides when that turn runs; the turn decides whether the Brief reads differently. Every value is synthetic.
const DAY = '2030-03-04';
const before = (over: Partial<Parameters<typeof briefBodyBefore>[0]> = {}) =>
  briefBodyBefore({ day: DAY, reached: true, doneOn: undefined, todayRow: async () => false, ...over });
const modelDay = async () => DAY;

describe('when the Brief is looked at again for body data', () => {
  it('golden: the Brief went out, the run wrote today\'s first row, and the turn can read it', async () => {
    expect(await before()).toBe(false);
    expect(await briefBodyAfter(false, 'written', modelDay, DAY)).toBe('go');
  });

  it('reads nothing while the Brief has not reached the owner, or once it was looked at today', async () => {
    let reads = 0;
    const todayRow = async () => { reads += 1; return false; };
    expect(await before({ reached: false, todayRow })).toBeNull();
    expect(await before({ doneOn: DAY, todayRow })).toBeNull();
    expect(reads).toBe(0);
    expect(await before({ doneOn: '2030-03-03' })).toBe(false);
  });

  it('a row that was already there, a run that wrote nothing, or nothing to decide, starts no turn', async () => {
    expect(await briefBodyAfter(true, 'written', modelDay, DAY)).toBe('row_before');
    expect(await briefBodyAfter(false, 'unchanged', modelDay, DAY)).toBeNull();
    expect(await briefBodyAfter(null, 'written', modelDay, DAY)).toBeNull();
  });

  it('a failed read is a closed code, never a turn', async () => {
    expect(await before({ todayRow: async () => { throw new Error('synthetic'); } })).toBe('unread');
    expect(await briefBodyAfter('unread', 'written', modelDay, DAY)).toBe('row_unread');
  });

  it('with model-use consent withdrawn, or the read failing, the turn would read nothing, so none runs', async () => {
    expect(await briefBodyAfter(false, 'written', async () => null, DAY)).toBe('no_model_health');
    expect(await briefBodyAfter(false, 'written', async () => { throw new Error('synthetic'); }, DAY)).toBe('no_model_health');
    expect(await briefBodyAfter(false, 'written', async () => '2030-03-03', DAY)).toBe('no_model_health');
  });
});

describe('what the turn may answer', () => {
  it('a whole Brief, or leaving it', () => {
    expect(briefBodyRevision('{"revise": {"card": "card:brief", "text": "Lighter morning: the hard block moves to 14:00."}}')).toEqual({ text: 'Lighter morning: the hard block moves to 14:00.' });
    expect(briefBodyRevision('{}')).toBe('left');
    expect(briefBodyRevision('SKIP')).toBe('left');
  });

  it('another card, a message, a push or prose is not a Brief revision', () => {
    expect(briefBodyRevision('{"revise": {"card": "card:close", "text": "x"}}')).toBe('invalid');
    expect(briefBodyRevision('{"say": "Your HRV is up."}')).toBe('invalid');
    expect(briefBodyRevision('{"revise": {"card": "card:brief", "text": "x"}, "push": {}}')).toBe('invalid');
    expect(briefBodyRevision('I think the Brief is fine.')).toBe('invalid');
  });

  it('the prompt asks for a short note only where a card cannot be edited', () => {
    expect(briefBodyPrompt('2030-03-04 09:40', 'Today\'s cards: The Daily Brief was sent.', true)).not.toContain('short note');
    expect(briefBodyPrompt('2030-03-04 09:40', 'Today\'s cards: The Daily Brief was sent.', false)).toContain('short note');
  });
});
